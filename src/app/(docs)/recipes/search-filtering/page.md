---
title: Search & filtering
nextjs:
  metadata:
    title: Search & filtering
    description: Build multi-column text search, combined filters, and advanced query patterns.
---

This recipe covers everything beyond basic `WHERE` clauses — multi-column text search, combining independent filters, OR groups, subquery filters, and custom LIKE patterns. For the full list-endpoint pattern (pagination, sorting, export, bulk), see [Paginated lists](/recipes/paginated-lists).

---

## Multi-column text search with WhereSearch

`WhereSearch` is the primary tool for free-text search. It searches multiple columns with a single call, handles LIKE escaping internally, and composes correctly with other AND conditions.

```go
func buildUserSelect(r *http.Request) *sqlite.SelectBuilder {
    q := sqlite.Select("id", "name", "email", "role", "created_at").
        From("users").
        WhereNull("deleted_at")

    search := r.URL.Query().Get("search")
    q.WhereSearch(search, "name", "email")

    return q
}
```

What `WhereSearch("alice", "name", "email")` generates:

```sql
WHERE deleted_at IS NULL AND (name LIKE '%alice%' ESCAPE '\' OR email LIKE '%alice%' ESCAPE '\')
```

Key behaviors:

- **No-op when empty.** If `search` is `""` or no columns are given, the call does nothing — no need to guard with `if search != ""`.
- **Automatic escaping.** Characters `%`, `_`, and `\` in the search term are escaped via `EscapeLike`, so user input like `100%` or `_admin` is safe.
- **Parenthesized OR group.** The column conditions are wrapped in parentheses, so they compose correctly with other AND conditions on the builder.
- **Available on all builders.** `SelectBuilder`, `CountBuilder`, `UpdateBuilder`, and `DeleteBuilder` all have `WhereSearch`.

Choose columns that make sense for the entity. Good candidates: `name`, `email`, `title`, `description`, `key_prefix`, `action`. Avoid searching numeric or timestamp columns — they won't match text patterns.

---

## Combining multiple filters

Real list endpoints combine text search with exact-match filters, date ranges, and foreign key lookups. Each filter is added conditionally — only when the query parameter is present.

The audit log handler is the most complete example:

```go
func buildAuditSelect(r *http.Request) *sqlite.SelectBuilder {
    q := sqlite.Select(
        "audit_log.id", "audit_log.admin_id",
        sqlite.CoalesceEmpty("admins.email"), sqlite.CoalesceEmpty("admins.name"),
        "audit_log.action", "audit_log.entity_type", "audit_log.entity_id",
        "audit_log.details", "audit_log.ip_address", "audit_log.created_at",
    ).From("audit_log").
        LeftJoin("admins", "admins.id = CAST(audit_log.admin_id AS INTEGER)")

    // Exact match filter
    if action := r.URL.Query().Get("action"); action != "" {
        q.Where("audit_log.action = ?", action)
    }

    // Foreign key filter
    if adminID := r.URL.Query().Get("admin_id"); adminID != "" {
        q.Where("audit_log.admin_id = ?", adminID)
    }

    // Multi-column text search
    q.WhereSearch(r.URL.Query().Get("search"), "audit_log.details", "audit_log.action")

    // Date range — lower bound
    if from := r.URL.Query().Get("from"); from != "" {
        q.Where("audit_log.created_at >= ?", from)
    }

    // Date range — upper bound
    if to := r.URL.Query().Get("to"); to != "" {
        q.Where("audit_log.created_at <= ?", to)
    }

    return q
}
```

A request like `GET /api/admin/audit?action=admin.create&search=settings&from=2025-01-01` generates:

```sql
WHERE audit_log.action = 'admin.create'
  AND (audit_log.details LIKE '%settings%' ESCAPE '\' OR audit_log.action LIKE '%settings%' ESCAPE '\')
  AND audit_log.created_at >= '2025-01-01'
```

The pattern: each `.Where()` call adds an AND condition. `WhereSearch` adds a parenthesized OR group that nests inside the AND chain. Filters that the user didn't provide are simply not added — the builder produces only the clauses you call.

---

## Common filter types

| Filter | Method | Example |
|--------|--------|---------|
| Exact match | `Where("col = ?", val)` | Status, role, entity type |
| Text search | `WhereSearch(val, cols...)` | Name, email, description |
| Date range | `Where("col >= ?", from)` | Created after, updated before |
| NULL check | `WhereNull("col")` / `WhereNotNull("col")` | Soft-deleted, has value |
| Set membership | `WhereIn("col", vals...)` | Multiple statuses, ID lists |
| Set exclusion | `WhereNotIn("col", vals...)` | Exclude statuses, skip IDs |
| Negation | `Where("col != ?", val)` | Exclude a status |

All filters compose with AND. For OR logic between different filters, use `WhereOr`.

---

## OR conditions with WhereOr

When you need OR logic between different conditions (not just different columns for the same search term), use `WhereOr` with `sqlite.Cond`:

```go
// Clean up expired or revoked API keys
query, args := sqlite.Delete("api_keys").
    WhereOr(
        sqlite.Cond("revoked_at IS NOT NULL AND revoked_at < ?", cutoff),
        sqlite.Cond("expires_at IS NOT NULL AND expires_at < ?", cutoff),
    ).Build()
db.Exec(query, args...)
```

Generated SQL:

```sql
DELETE FROM api_keys
WHERE (revoked_at IS NOT NULL AND revoked_at < ? OR expires_at IS NOT NULL AND expires_at < ?)
```

Rules:

- **Minimum 2 conditions.** With fewer than 2, `WhereOr` is a no-op — use `Where` for single conditions.
- **Parenthesized.** The OR group is wrapped in parentheses, so it composes correctly with other AND conditions.
- **Each Cond is a fragment.** A `Cond` can contain its own AND logic (as shown above).

---

## Subquery filters

For filtering based on related tables, the query builder supports IN/NOT IN/EXISTS with subqueries:

```go
// Users who have active sessions
q := sqlite.Select("id", "name", "email").From("users").
    WhereInSelect("id",
        sqlite.Select("user_id").From("sessions").Where("expires_at > ?", now),
    )

// Admins who are NOT assigned to any role
q := sqlite.Select("id", "name").From("admins").
    WhereNotInSelect("id",
        sqlite.Select("admin_id").From("admin_role_assignments"),
    )

// Users who have at least one order (EXISTS is often faster than IN for large tables)
q := sqlite.Select("*").From("users u").
    WhereExists(
        sqlite.Select("1").From("orders o").Where("o.user_id = u.id"),
    )
```

Use `WhereInSelect` / `WhereNotInSelect` when filtering by a column that appears in another table. Use `WhereExists` / `WhereNotExists` when checking for the existence of related rows — SQLite can often optimize EXISTS with an early exit.

---

## Custom LIKE patterns with EscapeLike

`WhereSearch` always does a contains match (`%term%`). For prefix-only, suffix-only, or more complex LIKE patterns, use `EscapeLike` directly with `Where`:

```go
search := r.URL.Query().Get("search")
if search != "" {
    // Prefix match — "starts with"
    like := sqlite.EscapeLike(search) + "%"
    q.Where("key_prefix LIKE ? ESCAPE '\\'", like)
}
```

```go
// Suffix match — "ends with"
like := "%" + sqlite.EscapeLike(search)
q.Where("email LIKE ? ESCAPE '\\'", like)
```

```go
// Exact domain match — "@example.com"
like := "%@" + sqlite.EscapeLike(domain)
q.Where("email LIKE ? ESCAPE '\\'", like)
```

Always use `EscapeLike` when interpolating user input into a LIKE pattern. Without it, a search term containing `%` or `_` would match unintended rows.

---

## Reusing filters across list and export

Extract the builder function so list, export, and count handlers all apply identical filters:

```go
func buildSelect(r *http.Request) *sqlite.SelectBuilder {
    q := sqlite.Select("id", "name", "email", "created_at").
        From("users").
        WhereNull("deleted_at")

    q.WhereSearch(r.URL.Query().Get("search"), "name", "email")

    if role := r.URL.Query().Get("role"); role != "" {
        q.Where("role = ?", role)
    }
    return q
}

// List — paginated JSON
func listHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        pg := http.ParsePagination(r, 50, 100)
        col, dir := http.QueryParamSort(r, allowedCols, "id", "DESC")

        selectQ := buildSelect(r).OrderBy(col, dir).Limit(pg.Limit).Offset(pg.Offset)

        var total int
        sql, args := sqlite.CountFrom(selectQ).Build()
        _ = db.QueryRow(sql, args...).Scan(&total)

        sql, args = selectQ.Build()
        rows, err := db.Query(sql, args...)
        if err != nil {
            http.WriteServerError(w, r, "failed to list", err)
            return
        }
        defer rows.Close()

        // ... scan rows ...
        http.PaginatedResponse(w, "users", users, total)
    }
}

// Export — full CSV, no pagination
func exportHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        col, dir := http.QueryParamSort(r, allowedCols, "id", "DESC")
        selectQ := buildSelect(r).OrderBy(col, dir)

        sql, args := selectQ.Build()
        rows, err := db.Query(sql, args...)
        if err != nil {
            http.WriteServerError(w, r, "failed to export", err)
            return
        }
        defer rows.Close()

        http.WriteCSV(w, "users", []string{"ID", "Name", "Email", "Created"}, func() []string {
            if !rows.Next() {
                return nil
            }
            var id int64
            var name, email, createdAt string
            if err := rows.Scan(&id, &name, &email, &createdAt); err != nil {
                return nil
            }
            return []string{sqlite.FormatID(id), name, email, createdAt}
        })
    }
}
```

The builder function is the single source of truth for filtering. Every handler that queries the same entity reuses it.

---

## Rules

1. **Use `WhereSearch` for text search, not manual LIKE.** It handles escaping, OR grouping, and empty-string no-op automatically.
2. **Search meaningful text columns.** Names, emails, titles, descriptions — not IDs or timestamps.
3. **Add filters conditionally.** Only call `.Where()` when the query parameter is present. The builder produces only the clauses you add.
4. **Use `WhereOr` for OR between different conditions.** Use `WhereSearch` for OR between columns with the same search term.
5. **Use `EscapeLike` for custom LIKE patterns.** Prefix, suffix, or domain matching — always escape user input.
6. **Use subquery filters for related tables.** `WhereInSelect`, `WhereNotInSelect`, `WhereExists` — let the database do the join.
7. **Extract the builder function.** List, export, and count handlers should share the same filter logic.
