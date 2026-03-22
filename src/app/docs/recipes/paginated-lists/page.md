---
title: Paginated lists
nextjs:
  metadata:
    title: Paginated lists
    description: Build paginated, sortable list endpoints with bulk actions and CSV export.
---

This recipe shows how to build a complete list endpoint with pagination, sorting, filtering, bulk actions, and CSV export — the pattern used by every admin module in the standalone app.

---

## The list handler

A typical list endpoint combines four framework helpers:

- `http.ParsePagination` — extracts and validates `limit`/`offset` query params
- `http.QueryParamSort` — validates `sort`/`order` query params against a whitelist
- `sqlite.SelectBuilder` — builds the filtered, sorted, paginated query
- `sqlite.CountFrom` — derives a COUNT query from the SelectBuilder (no duplicated WHERE logic)

```go
func listHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        pg := http.ParsePagination(r, 50, 100)
        col, dir := http.QueryParamSort(r,
            []string{"id", "name", "email", "created_at"},
            "id", "DESC",
        )

        selectQ := sqlite.Select("id", "name", "email", "created_at").
            From("users").
            Where("deleted_at IS NULL").
            OrderBy(col, dir).
            Limit(pg.Limit).
            Offset(pg.Offset)

        // Apply optional filters from query params
        if search := http.QueryParam(r, "search"); search != "" {
            selectQ.Where("(name LIKE ? OR email LIKE ?)", "%"+search+"%", "%"+search+"%")
        }
        if role := http.QueryParam(r, "role"); role != "" {
            selectQ.Where("role = ?", role)
        }

        // COUNT reuses table + WHERE from selectQ
        countQ := sqlite.CountFrom(selectQ)

        // Execute the SELECT
        sql, args := selectQ.Build()
        rows, err := db.Query(sql, args...)
        if err != nil {
            http.WriteError(w, http.StatusInternalServerError, "failed to list users")
            return
        }
        defer rows.Close()

        var users []map[string]any
        for rows.Next() {
            var id, createdAt int64
            var name, email string
            if err := rows.Scan(&id, &name, &email, &createdAt); err != nil {
                http.WriteError(w, http.StatusInternalServerError, "failed to scan user")
                return
            }
            users = append(users, map[string]any{
                "id": id, "name": name, "email": email, "created_at": createdAt,
            })
        }

        // Execute the COUNT
        sql, args = countQ.Build()
        var total int
        if err := db.QueryRow(sql, args...).Scan(&total); err != nil {
            http.WriteError(w, http.StatusInternalServerError, "failed to count users")
            return
        }

        http.PaginatedResponse(w, "users", users, total)
    }
}
```

The client requests: `GET /api/admin/users?search=alice&sort=name&order=asc&limit=20&offset=40`

Response:

```json
{
  "users": [
    {"id": 42, "name": "Alice", "email": "alice@example.com", "created_at": 1710892800}
  ],
  "total": 1
}
```

---

## Extracting the query builder

When both the list handler and export handler need the same filters, extract the builder into a shared function:

```go
func buildUserSelect(r *http.Request) *sqlite.SelectBuilder {
    selectQ := sqlite.Select("id", "name", "email", "role", "created_at").
        From("users").
        Where("deleted_at IS NULL")

    if search := http.QueryParam(r, "search"); search != "" {
        selectQ.Where("(name LIKE ? OR email LIKE ?)", "%"+search+"%", "%"+search+"%")
    }
    if role := http.QueryParam(r, "role"); role != "" {
        selectQ.Where("role = ?", role)
    }

    return selectQ
}
```

Now both handlers reuse the same filter logic:

```go
// List handler
func listHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        pg := http.ParsePagination(r, 50, 100)
        col, dir := http.QueryParamSort(r, allowedCols, "id", "DESC")

        selectQ := buildUserSelect(r).OrderBy(col, dir).Limit(pg.Limit).Offset(pg.Offset)
        countQ := sqlite.CountFrom(selectQ)

        // ... execute and respond ...
    }
}

// Export handler — same filters, no pagination
func exportHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        col, dir := http.QueryParamSort(r, allowedCols, "id", "DESC")
        selectQ := buildUserSelect(r).OrderBy(col, dir)

        // ... execute and write CSV ...
    }
}
```

---

## CSV export

Export the filtered data as a downloadable CSV file. The export handler reuses the same query builder as the list handler but without pagination — all matching rows are exported:

```go
func exportHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        col, dir := http.QueryParamSort(r,
            []string{"id", "name", "email", "created_at"},
            "id", "DESC",
        )

        selectQ := buildUserSelect(r).OrderBy(col, dir)
        sql, args := selectQ.Build()
        rows, err := db.Query(sql, args...)
        if err != nil {
            http.WriteError(w, http.StatusInternalServerError, "failed to export")
            return
        }
        defer rows.Close()

        w.Header().Set("Content-Type", "text/csv")
        w.Header().Set("Content-Disposition",
            fmt.Sprintf("attachment; filename=users-%s.csv",
                time.Now().UTC().Format("20060102")))

        cw := csv.NewWriter(w)
        _ = cw.Write([]string{"ID", "Name", "Email", "Role", "Created At"})

        for rows.Next() {
            var id int64
            var name, email, role string
            var createdAt int64
            if err := rows.Scan(&id, &name, &email, &role, &createdAt); err != nil {
                break
            }
            _ = cw.Write([]string{
                strconv.FormatInt(id, 10),
                name, email, role,
                time.Unix(createdAt, 0).UTC().Format(time.RFC3339),
            })
        }
        cw.Flush()
    }
}
```

Register on a separate route:

```go
group.HandleFunc("GET /users", listHandler(db))
group.HandleFunc("GET /users/export", exportHandler(db))
```

---

## Bulk actions

Bulk actions receive an array of IDs in the JSON body, validate them, and execute a single query:

```go
func bulkDeleteHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        var req struct {
            IDs []string `json:"ids"`
        }
        if err := http.ReadJSON(r, &req); err != nil {
            http.WriteError(w, http.StatusBadRequest, "invalid request body")
            return
        }
        if len(req.IDs) == 0 {
            http.WriteError(w, http.StatusBadRequest, "ids required")
            return
        }
        if len(req.IDs) > 100 {
            http.WriteError(w, http.StatusBadRequest, "maximum 100 ids per request")
            return
        }

        // Build parameterized IN clause
        placeholders := make([]string, len(req.IDs))
        args := make([]any, len(req.IDs))
        for i, id := range req.IDs {
            placeholders[i] = "?"
            args[i] = id
        }

        query := fmt.Sprintf(
            "UPDATE users SET deleted_at = unixepoch() WHERE id IN (%s) AND deleted_at IS NULL",
            strings.Join(placeholders, ","),
        )
        result, err := db.Exec(query, args...)
        if err != nil {
            http.WriteError(w, http.StatusInternalServerError, "failed to delete users")
            return
        }

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "ok":       true,
            "affected": result.RowsAffected,
        })
    }
}
```

Register on a `DELETE` route:

```go
group.HandleFunc("DELETE /users/bulk", bulkDeleteHandler(db))
```

Key points:
- Always cap the number of IDs (e.g., 100) to prevent oversized queries
- Use parameterized placeholders (`?`) — never interpolate IDs directly into SQL
- Return `RowsAffected` so the client knows how many rows were actually modified
- For soft-delete, use `UPDATE ... SET deleted_at` instead of `DELETE`

---

## Putting it all together

Register all endpoints in your module:

```go
func Register(group *http.Group, db *sqlite.DB) {
    group.HandleFunc("GET /users", listHandler(db))
    group.HandleFunc("GET /users/export", exportHandler(db))
    group.HandleFunc("DELETE /users/bulk", bulkDeleteHandler(db))
    group.HandleFunc("GET /users/{id}", getHandler(db))
    group.HandleFunc("POST /users", createHandler(db))
    group.HandleFunc("PUT /users/{id}", updateHandler(db))
    group.HandleFunc("DELETE /users/{id}", deleteHandler(db))
}
```

The list, export, and bulk delete handlers share the same query builder function, keeping filter logic in one place. The list handler adds pagination and sorting; the export handler adds sorting without pagination; the bulk delete handler operates on explicit IDs.
