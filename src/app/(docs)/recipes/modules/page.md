---
title: Adding a module
nextjs:
  metadata:
    title: Adding a module
    description: Step-by-step guide to creating a new API module with CRUD endpoints.
---

This recipe walks through creating a new API module from scratch — a "products" module with full CRUD. Follow this pattern for any new feature in your Stanza app.

---

## Module structure

Every module is a single Go file in `api/module/{name}/{name}.go` with one exported function:

```go
package products

func Register(admin *http.Group, db *sqlite.DB) {
    // mount routes here
}
```

The `Register` function receives an already-protected route group and the dependencies it needs. Modules never depend on other modules — they're completely decoupled.

---

## Step 1: Write the migration

Add a migration in `api/migration/migration.go`. Use a Unix timestamp prefix:

```go
db.AddMigration(1742500000, "create_products", createProductsUp, createProductsDown)
```

```go
func createProductsUp(tx *sqlite.Tx) error {
    _, err := tx.Exec(`CREATE TABLE products (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        price_cents INTEGER NOT NULL DEFAULT 0,
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        deleted_at  TEXT
    )`)
    return err
}

func createProductsDown(tx *sqlite.Tx) error {
    _, err := tx.Exec(`DROP TABLE IF EXISTS products`)
    return err
}
```

Migrations run automatically on boot. No manual step needed.

---

## Step 2: Create the module

Create `api/module/products/products.go`:

```go
package products

import (
    "strconv"
    "time"

    "github.com/stanza-go/framework/pkg/http"
    "github.com/stanza-go/framework/pkg/sqlite"
    "github.com/stanza-go/framework/pkg/validate"
    "github.com/stanza-go/standalone/module/adminaudit"
)

// Register mounts product management routes on the given admin group.
func Register(admin *http.Group, db *sqlite.DB) {
    admin.HandleFunc("GET /products", listHandler(db))
    admin.HandleFunc("POST /products", createHandler(db))
    admin.HandleFunc("GET /products/{id}", getHandler(db))
    admin.HandleFunc("PUT /products/{id}", updateHandler(db))
    admin.HandleFunc("DELETE /products/{id}", deleteHandler(db))
}
```

---

## Step 3: Define the response type

Keep a single JSON struct for the resource:

```go
type productJSON struct {
    ID          int64  `json:"id"`
    Name        string `json:"name"`
    Description string `json:"description"`
    PriceCents  int    `json:"price_cents"`
    IsActive    bool   `json:"is_active"`
    CreatedAt   string `json:"created_at"`
    UpdatedAt   string `json:"updated_at"`
}
```

---

## Step 4: Implement handlers

Each handler is a closure factory that captures dependencies. Start by extracting a scan function for the module's JSON type — this function works with both `QueryAll` (lists) and `QueryOne` (details):

```go
func scanProduct(rows *sqlite.Rows) (productJSON, error) {
    var p productJSON
    var isActive int
    if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.PriceCents, &isActive, &p.CreatedAt, &p.UpdatedAt); err != nil {
        return p, err
    }
    p.IsActive = isActive == 1
    return p, nil
}
```

### List with search, pagination, and sorting

```go
func listHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        pg := http.ParsePagination(r, 50, 100)
        col, dir := http.QueryParamSort(r,
            []string{"id", "name", "price_cents", "is_active", "created_at"},
            "id", "DESC",
        )

        selectQ := sqlite.Select("id", "name", "description", "price_cents", "is_active", "created_at", "updated_at").
            From("products").
            WhereNull("deleted_at").
            WhereSearch(r.URL.Query().Get("search"), "name", "description")

        total, _ := db.Count(selectQ)

        sql, args := selectQ.OrderBy(col, dir).Limit(pg.Limit).Offset(pg.Offset).Build()
        products, err := sqlite.QueryAll(db, sql, args, scanProduct)
        if err != nil {
            http.WriteError(w, http.StatusInternalServerError, "failed to list products")
            return
        }

        http.PaginatedResponse(w, "products", products, total)
    }
}
```

`WhereSearch` handles LIKE escaping automatically — no manual escape helper needed. When the search string is empty, it's a no-op. `db.Count` derives a COUNT query from the SelectBuilder, reusing the same WHERE conditions without duplication. For advanced filter patterns — multi-column search, OR conditions, subquery filters — see the [Search & filtering](/docs/recipes/search-filtering) recipe.

### Create with validation

```go
type createRequest struct {
    Name        string `json:"name"`
    Description string `json:"description"`
    PriceCents  int    `json:"price_cents"`
}

func createHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        var req createRequest
        if err := http.ReadJSON(r, &req); err != nil {
            http.WriteError(w, http.StatusBadRequest, "invalid request body")
            return
        }

        v := validate.Fields(
            validate.Required("name", req.Name),
            validate.MaxLen("name", req.Name, 255),
            validate.Positive("price_cents", req.PriceCents),
        )
        if v.HasErrors() {
            v.WriteError(w)
            return
        }

        now := sqlite.Now()
        sql, args := sqlite.Insert("products").
            Set("name", req.Name).
            Set("description", req.Description).
            Set("price_cents", req.PriceCents).
            Set("created_at", now).
            Set("updated_at", now).
            Build()
        result, err := db.Exec(sql, args...)
        if err != nil {
            http.WriteError(w, http.StatusInternalServerError, "failed to create product")
            return
        }

        adminaudit.Log(db, r, "product.create", "product", strconv.FormatInt(result.LastInsertID, 10), req.Name)

        http.WriteJSON(w, http.StatusCreated, map[string]any{
            "product": productJSON{
                ID:          result.LastInsertID,
                Name:        req.Name,
                Description: req.Description,
                PriceCents:  req.PriceCents,
                IsActive:    true,
                CreatedAt:   now,
                UpdatedAt:   now,
            },
        })
    }
}
```

### Get by ID

```go
func getHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        id, ok := http.PathParamInt64(w, r, "id")
        if !ok {
            return
        }

        sql, args := sqlite.Select("id", "name", "description", "price_cents", "is_active", "created_at", "updated_at").
            From("products").
            Where("id = ?", id).
            WhereNull("deleted_at").
            Build()
        p, err := sqlite.QueryOne(db, sql, args, scanProduct)
        if err != nil {
            http.WriteError(w, http.StatusNotFound, "product not found")
            return
        }

        http.WriteJSON(w, http.StatusOK, map[string]any{"product": p})
    }
}
```

### Update

```go
type updateRequest struct {
    Name        string `json:"name"`
    Description string `json:"description"`
    PriceCents  *int   `json:"price_cents"`
    IsActive    *bool  `json:"is_active"`
}

func updateHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        id, ok := http.PathParamInt64(w, r, "id")
        if !ok {
            return
        }

        var req updateRequest
        if err := http.ReadJSON(r, &req); err != nil {
            http.WriteError(w, http.StatusBadRequest, "invalid request body")
            return
        }

        // Load current product.
        var curName, curDesc, createdAt string
        var curPrice, curActive int
        sql, args := sqlite.Select("name", "description", "price_cents", "is_active", "created_at").
            From("products").
            Where("id = ?", id).
            WhereNull("deleted_at").
            Build()
        if err := db.QueryRow(sql, args...).Scan(&curName, &curDesc, &curPrice, &curActive, &createdAt); err != nil {
            http.WriteError(w, http.StatusNotFound, "product not found")
            return
        }

        // Merge updates.
        name := curName
        if req.Name != "" {
            name = req.Name
        }
        desc := curDesc
        if req.Description != "" {
            desc = req.Description
        }
        price := curPrice
        if req.PriceCents != nil {
            price = *req.PriceCents
        }
        isActive := curActive
        if req.IsActive != nil {
            if *req.IsActive {
                isActive = 1
            } else {
                isActive = 0
            }
        }

        now := sqlite.Now()
        sql, args = sqlite.Update("products").
            Set("name", name).
            Set("description", desc).
            Set("price_cents", price).
            Set("is_active", isActive).
            Set("updated_at", now).
            Where("id = ?", id).
            WhereNull("deleted_at").
            Build()
        if _, err := db.Exec(sql, args...); err != nil {
            http.WriteError(w, http.StatusInternalServerError, "failed to update product")
            return
        }

        adminaudit.Log(db, r, "product.update", "product", strconv.FormatInt(id, 10), curName)

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "product": productJSON{
                ID:          id,
                Name:        name,
                Description: desc,
                PriceCents:  price,
                IsActive:    isActive == 1,
                CreatedAt:   createdAt,
                UpdatedAt:   now,
            },
        })
    }
}
```

### Soft-delete

```go
func deleteHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        id, ok := http.PathParamInt64(w, r, "id")
        if !ok {
            return
        }

        now := sqlite.Now()
        sql, args := sqlite.Update("products").
            Set("deleted_at", now).
            Set("is_active", 0).
            Set("updated_at", now).
            Where("id = ?", id).
            WhereNull("deleted_at").
            Build()
        result, err := db.Exec(sql, args...)
        if err != nil {
            http.WriteError(w, http.StatusInternalServerError, "failed to delete product")
            return
        }
        if result.RowsAffected == 0 {
            http.WriteError(w, http.StatusNotFound, "product not found")
            return
        }

        adminaudit.Log(db, r, "product.delete", "product", strconv.FormatInt(id, 10), "")

        http.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
    }
}
```

## Step 5: Wire into main.go

In `registerModules()`, import and mount the module:

```go
import "github.com/stanza-go/standalone/module/products"

func registerModules(router *http.Router, db *sqlite.DB, a *auth.Auth, ...) {
    api := router.Group("/api")

    // ... existing routes ...

    admin := api.Group("/admin")
    admin.Use(a.RequireAuth())
    admin.Use(auth.RequireScope("admin"))

    products.Register(admin, db)  // ← add this line
}
```

That's it. The routes are live at `/api/admin/products`.

---

## Testing

```go
// api/module/products/products_test.go
package products

import (
    "testing"
    "github.com/stanza-go/standalone/testutil"
)

func TestCreateProduct(t *testing.T) {
    db := testutil.SetupDB(t)
    // run migration, register routes, use httptest
}
```

Run with `go test -race ./module/products/`.

---

## Key patterns

| Pattern | Detail |
|---------|--------|
| One file per module | `module/{name}/{name}.go` |
| One exported function | `Register(group, deps...)` |
| Closure-based handlers | Factory functions capture dependencies |
| Soft deletes | `deleted_at` field, `WHERE deleted_at IS NULL` |
| Booleans as integers | SQLite has no bool — use `INTEGER` with 0/1 |
| Timestamps as text | `time.RFC3339` format in UTC |
| Pre-allocated empty slices | `make([]T, 0)` not `nil` — matters for JSON |
| Audit logging | Call `adminaudit.Log()` after every mutation |
