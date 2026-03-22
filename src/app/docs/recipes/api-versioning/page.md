---
title: API versioning
nextjs:
  metadata:
    title: API versioning
    description: How to version your API using URL path groups — when to version, how to structure v1/v2 route groups, and how to evolve schemas without breaking clients.
---

This recipe covers API versioning using URL path groups (`/api/v1/...`, `/api/v2/...`). You'll learn when versioning is actually needed, how to structure versioned route groups, how to share code between versions, and how to deprecate old versions safely.

---

## When to version

Most Stanza apps start without versioning. The standalone app serves endpoints directly under `/api/` — and that's fine for an MVP. You need versioning when:

- **External clients depend on your API.** Mobile apps, third-party integrations, or published SDKs can't update instantly when you change a response shape.
- **You need to make a breaking change.** Renaming a field, removing an endpoint, or changing a response structure breaks existing clients.

You do **not** need versioning for:

- **Adding new fields** to a response — existing clients ignore unknown fields.
- **Adding new endpoints** — no one is calling them yet.
- **Internal-only APIs** — if you control all the clients (admin panel, your own frontend), just update everything together.

{% callout title="Start without versions" %}
Don't add `/api/v1/` from day one "just in case." Versioning adds complexity. Introduce it when the first breaking change is unavoidable.
{% /callout %}

---

## URL path versioning

Stanza uses URL path versioning — the version is part of the URL (`/api/v1/products`, `/api/v2/products`). This is the simplest approach: visible in logs, easy to route, no content negotiation complexity.

Other approaches (header-based `Accept: application/vnd.app.v2+json`, query parameter `?version=2`) add ambiguity. URL paths are explicit and unambiguous — exactly what makes AI-generated code reliable.

---

## Setting up v1

When you're ready to version, create a versioned route group and register your modules on it:

```go
func registerModules(router *http.Router, db *sqlite.DB, a *auth.Auth) {
    api := router.Group("/api")

    // Unversioned routes — health, metrics, auth.
    // These don't change between API versions.
    health.Register(api, db, buildInfo)
    api.HandleFunc("GET /metrics", http.PrometheusHandler(collector))

    // Auth routes — shared across all versions.
    authRL := api.Group("")
    authRL.Use(http.RateLimit(http.RateLimitConfig{
        Limit:  20,
        Window: time.Minute,
    }))
    adminauth.Register(authRL, a, db, logger)

    // v1 — current stable version.
    v1 := api.Group("/v1")
    v1.Use(a.RequireAuth())
    products.RegisterV1(v1, db)
    orders.RegisterV1(v1, db)
}
```

Auth, health, and metrics live outside any version — they're infrastructure, not business API. Business endpoints live under `/v1`.

---

## Adding v2

When a breaking change is needed, create a v2 group alongside v1:

```go
func registerModules(router *http.Router, db *sqlite.DB, a *auth.Auth) {
    api := router.Group("/api")

    // Infrastructure — unversioned.
    health.Register(api, db, buildInfo)

    authRL := api.Group("")
    authRL.Use(http.RateLimit(http.RateLimitConfig{
        Limit:  20,
        Window: time.Minute,
    }))
    adminauth.Register(authRL, a, db, logger)

    // v1 — maintained for existing clients.
    v1 := api.Group("/v1")
    v1.Use(a.RequireAuth())
    products.RegisterV1(v1, db)
    orders.RegisterV1(v1, db)

    // v2 — new version with breaking changes.
    v2 := api.Group("/v2")
    v2.Use(a.RequireAuth())
    products.RegisterV2(v2, db)  // changed response shape
    orders.RegisterV1(v2, db)    // unchanged — reuse v1 handlers
}
```

Key points:

- Both versions exist simultaneously in the same binary.
- Unchanged modules use the same `Register` function on both groups.
- Only modules with breaking changes get a new `RegisterV2`.

---

## Module with two versions

When a module needs different behavior per version, export separate registration functions. Keep shared logic in unexported functions:

```go
package products

import (
    "github.com/stanza-go/framework/pkg/http"
    "github.com/stanza-go/framework/pkg/sqlite"
)

// RegisterV1 mounts v1 product endpoints.
func RegisterV1(group *http.Group, db *sqlite.DB) {
    group.HandleFunc("GET /products", listV1(db))
    group.HandleFunc("GET /products/{id}", getV1(db))
    group.HandleFunc("POST /products", create(db))      // shared
    group.HandleFunc("PUT /products/{id}", update(db))   // shared
    group.HandleFunc("DELETE /products/{id}", remove(db)) // shared
}

// RegisterV2 mounts v2 product endpoints with updated response shapes.
func RegisterV2(group *http.Group, db *sqlite.DB) {
    group.HandleFunc("GET /products", listV2(db))
    group.HandleFunc("GET /products/{id}", getV2(db))
    group.HandleFunc("POST /products", create(db))      // shared
    group.HandleFunc("PUT /products/{id}", update(db))   // shared
    group.HandleFunc("DELETE /products/{id}", remove(db)) // shared
}
```

Only the list and get handlers differ between v1 and v2. Create, update, and delete are the same — reuse them directly.

---

## Changing response shapes

The most common breaking change is restructuring a response. Keep the database query shared and only change the serialization:

```go
// queryProduct fetches a product from the database.
// Shared between v1 and v2 — the query doesn't change.
func queryProduct(db *sqlite.DB, id int64) (*product, error) {
    row := db.QueryRow("SELECT id, name, price_cents, currency, is_active, created_at FROM products WHERE id = ? AND deleted_at IS NULL", id)
    var p product
    err := row.Scan(&p.ID, &p.Name, &p.PriceCents, &p.Currency, &p.IsActive, &p.CreatedAt)
    if err != nil {
        return nil, err
    }
    return &p, nil
}

// v1: flat response with price_cents as an integer.
func getV1(db *sqlite.DB) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        id, ok := http.PathParamInt64(w, r, "id")
        if !ok {
            return
        }

        p, err := queryProduct(db, id)
        if err != nil {
            http.WriteError(w, http.StatusNotFound, "product not found")
            return
        }

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "id":          p.ID,
            "name":        p.Name,
            "price_cents": p.PriceCents,
            "is_active":   p.IsActive,
            "created_at":  p.CreatedAt,
        })
    }
}

// v2: nested price object with formatted amount.
func getV2(db *sqlite.DB) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        id, ok := http.PathParamInt64(w, r, "id")
        if !ok {
            return
        }

        p, err := queryProduct(db, id)
        if err != nil {
            http.WriteError(w, http.StatusNotFound, "product not found")
            return
        }

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "id":   p.ID,
            "name": p.Name,
            "price": map[string]any{
                "amount":   float64(p.PriceCents) / 100,
                "cents":    p.PriceCents,
                "currency": p.Currency,
            },
            "active":     p.IsActive,
            "created_at": p.CreatedAt,
        })
    }
}
```

The v2 response nests price into an object and renames `is_active` to `active`. Both handlers query the same table, same row — only the JSON shape differs.

---

## Database schema evolution

Both API versions share the same database. When v2 needs new columns, add them in a way that doesn't break v1:

```go
// Migration: add currency column for v2 price object.
func addCurrencyUp(tx *sqlite.Tx) error {
    _, err := tx.Exec(`ALTER TABLE products ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'`)
    return err
}
```

Rules for schema changes across versions:

- **New columns with defaults are safe.** v1 handlers simply ignore columns they don't query.
- **Never drop columns that v1 reads.** Remove them only after v1 is decommissioned.
- **Never rename columns.** Add the new name, backfill, and keep the old name until v1 is gone.
- **New tables are always safe.** No existing handler queries a table it doesn't know about.

{% callout title="SQLite ALTER TABLE" type="warning" %}
SQLite only supports `ADD COLUMN` for ALTER TABLE. You cannot drop or rename columns in older SQLite versions. This constraint naturally prevents dangerous schema changes — a useful guardrail when maintaining multiple API versions.
{% /callout %}

---

## Deprecation headers

When v1 is scheduled for removal, communicate it through response headers using middleware:

```go
func DeprecationNotice(sunset string, docURL string) http.Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("Deprecation", "true")
            w.Header().Set("Sunset", sunset)
            if docURL != "" {
                w.Header().Set("Link", "<"+docURL+">; rel=\"successor-version\"")
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

Apply it to the v1 group:

```go
v1 := api.Group("/v1")
v1.Use(a.RequireAuth())
v1.Use(DeprecationNotice(
    "Sat, 01 Nov 2026 00:00:00 GMT",
    "https://docs.example.com/api/v2/migration",
))
products.RegisterV1(v1, db)
```

Every v1 response now includes deprecation headers. Clients can detect these programmatically and alert their developers.

---

## Version-specific middleware

Different versions may need different middleware configurations:

```go
// v1 — liberal rate limit for existing clients during transition.
v1 := api.Group("/v1")
v1.Use(a.RequireAuth())
v1.Use(http.RateLimit(http.RateLimitConfig{
    Limit:  300,
    Window: time.Minute,
}))

// v2 — stricter limits, new middleware.
v2 := api.Group("/v2")
v2.Use(a.RequireAuth())
v2.Use(http.RateLimit(http.RateLimitConfig{
    Limit:  100,
    Window: time.Minute,
}))
```

Each version group has its own middleware stack. This lets you evolve security policies, rate limits, and auth requirements independently.

---

## Testing multiple versions

Verify both versions respond correctly:

```bash
# v1 — flat price
curl -s http://localhost:23710/api/v1/products/1 \
  -H "Cookie: access_token=..." | jq .
# {"id":1, "name":"Widget", "price_cents":1999, "is_active":true, ...}

# v2 — nested price object
curl -s http://localhost:23710/api/v2/products/1 \
  -H "Cookie: access_token=..." | jq .
# {"id":1, "name":"Widget", "price":{"amount":19.99, "cents":1999, "currency":"USD"}, "active":true, ...}
```

Check deprecation headers on v1:

```bash
curl -sI http://localhost:23710/api/v1/products \
  -H "Cookie: access_token=..." | grep -i "deprecation\|sunset\|link"
# Deprecation: true
# Sunset: Sat, 01 Nov 2026 00:00:00 GMT
# Link: <https://docs.example.com/api/v2/migration>; rel="successor-version"
```

---

## Removing an old version

When v1's sunset date passes and traffic has migrated:

1. Remove v1 registration from `registerModules`.
2. Delete or clean up v1-only handler functions from modules.
3. Drop columns that only v1 used (create a migration).
4. Remove the deprecation middleware.

```go
// Before: both versions
v1 := api.Group("/v1")
products.RegisterV1(v1, db)

v2 := api.Group("/v2")
products.RegisterV2(v2, db)

// After: v2 only — promote to unversioned or keep as /v2
v2 := api.Group("/v2")
products.RegisterV2(v2, db)
```

Whether to keep `/v2` in the path or promote endpoints back to unversioned (`/api/products`) depends on whether you expect a v3. If the API is stable, promoting to unversioned is cleaner.

---

## Tips

- **Don't version prematurely.** Start with unversioned `/api/` routes. Add versions only when a breaking change is unavoidable and external clients exist.
- **Version the group, not individual routes.** Use `api.Group("/v1")` to version all routes in a group at once. Don't mix `/api/products` and `/api/v1/orders` — it's confusing.
- **Share everything you can.** Database queries, validation logic, and write handlers rarely change between versions. Only the response serialization typically differs.
- **Keep v1 read-only after v2 launches.** New features go to v2 only. v1 gets bug fixes, not enhancements — this motivates migration.
- **Communicate deprecation early.** Add the `Deprecation` header weeks or months before the sunset date. Clients that check for it can plan ahead.
- **Auth is not versioned.** Login, token refresh, and session management stay outside version groups. Changing auth mechanics is a different kind of migration — handle it separately.
