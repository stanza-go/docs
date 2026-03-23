---
title: SQLite database
nextjs:
  metadata:
    title: SQLite database
    description: Vendored SQLite with CGo bindings, query builder, migrations, and transactions.
---

The `pkg/sqlite` package provides a complete SQLite integration built from the vendored amalgamation (`sqlite3.c`) via CGo. No `database/sql`, no third-party drivers — direct C API bindings with a clean Go interface.

```go
import "github.com/stanza-go/framework/pkg/sqlite"
```

---

## Opening a database

```go
db := sqlite.New("path/to/database.sqlite",
    sqlite.WithBusyTimeout(5000),         // ms, default: 5000
    sqlite.WithReadPoolSize(4),           // read connections, default: 4
    sqlite.WithPragma("cache_size=-20000"), // custom PRAGMA
)

// Open and configure (WAL mode, mmap, etc.)
if err := db.Start(ctx); err != nil {
    return err
}
defer db.Stop(ctx)
```

`Start` opens **1 write connection** and a **pool of read connections** (default 4), applying default PRAGMAs to all (WAL mode, memory-mapped I/O, optimized cache). The read pool lets multiple HTTP requests query the database simultaneously — each `Query` takes a connection from the pool, and `Rows.Close` returns it. Writes (`Exec`, transactions) use the dedicated write connection. `Stop` signals pool operations to stop, waits for all checked-out connections to be returned, then drains and closes everything — safe even if queries are still in-flight during shutdown.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `WithBusyTimeout(ms)` | 5000 | Milliseconds to wait when the database is locked before returning `SQLITE_BUSY` |
| `WithReadPoolSize(n)` | 4 | Number of read connections in the pool. Increase if profiling shows read contention under high concurrency |
| `WithPragma(stmt)` | — | Add a custom PRAGMA applied to all connections on open (e.g. `"cache_size=-20000"`) |
| `WithLogger(l)` | nil | Enable query logging — see [Query logging](#query-logging) below |
| `WithSlowThreshold(d)` | 200ms | Queries exceeding this duration are logged at Warn level. Requires a logger |

For in-memory databases (`:memory:`), a single connection is used because each open creates a separate database.

`db.Path()` returns the database file path passed to `New`.

In a Stanza app, the database is wired through the lifecycle — it starts first and stops last.

---

## Pool stats

Call `db.Stats()` for a snapshot of connection pool utilization and query counters:

```go
stats := db.Stats()
fmt.Println(stats.ReadPoolSize)      // configured pool size (e.g. 4)
fmt.Println(stats.ReadPoolAvailable) // idle connections right now
fmt.Println(stats.ReadPoolInUse)     // checked-out connections right now
fmt.Println(stats.TotalReads)        // cumulative read queries since Start
fmt.Println(stats.TotalWrites)       // cumulative write operations since Start
fmt.Println(stats.PoolWaits)         // times a read had to wait for a free connection
fmt.Println(stats.PoolWaitTime)      // cumulative time spent waiting
fmt.Println(stats.FileSize)          // main database file size in bytes
fmt.Println(stats.WALSize)           // WAL file size in bytes (0 if no WAL)
```

Use `PoolWaits` and `PoolWaitTime` to detect pool exhaustion — if waits are frequent, increase the pool size with `WithReadPoolSize`. Use `FileSize` and `WALSize` for monitoring database growth — a large WAL relative to the main file may indicate long-running read transactions blocking checkpoints. The counters are atomic and safe to call from any goroutine. Pool availability and file sizes are point-in-time snapshots.

---

## Query logging

Enable query instrumentation by passing a logger. Every query is logged at **Debug** level with its SQL and duration. Queries exceeding the slow threshold are logged at **Warn** level.

```go
db := sqlite.New("database.sqlite",
    sqlite.WithLogger(logger.With(log.String("pkg", "sqlite"))),
    sqlite.WithSlowThreshold(100 * time.Millisecond), // default: 200ms
)
```

Output at Debug level:

```json
{"time":"...","level":"debug","msg":"query","pkg":"sqlite","sql":"SELECT * FROM users WHERE id = ?","duration":"42µs"}
```

Slow queries and failed queries are logged at Warn level:

```json
{"time":"...","level":"warn","msg":"slow query","pkg":"sqlite","sql":"SELECT * FROM users","duration":"312ms"}
{"time":"...","level":"warn","msg":"query failed","pkg":"sqlite","sql":"INSERT INTO ...","duration":"1ms","error":"..."}
```

Duration includes mutex wait time, so it reflects total time from call to completion — useful for detecting contention. When no logger is configured, there is zero overhead.

---

## Queries

### Execute (INSERT, UPDATE, DELETE)

```go
result, err := db.Exec(
    "INSERT INTO users (name, email) VALUES (?, ?)",
    "Alice", "alice@example.com",
)
// result.LastInsertID — the new row's ID
// result.RowsAffected — number of rows changed
```

### Query rows

```go
rows, err := db.Query("SELECT id, name, email FROM users WHERE active = ?", true)
if err != nil {
    return err
}
defer rows.Close()

for rows.Next() {
    var id int64
    var name, email string
    if err := rows.Scan(&id, &name, &email); err != nil {
        return err
    }
    // use id, name, email
}
```

### Query single row

```go
var name string
err := db.QueryRow("SELECT name FROM users WHERE id = ?", 42).Scan(&name)
if err == sqlite.ErrNoRows {
    // not found
}
```

### QueryAll — scan rows into a slice

`QueryAll` is a generic helper that executes a query, scans every row using a provided function, and returns a typed slice. It handles the full lifecycle: query execution, iteration, scanning, error checking (`rows.Err()`), and cleanup (`rows.Close()`).

```go
type User struct {
    ID    int64
    Email string
    Name  string
}

sql, args := sqlite.Select("id", "email", "name").
    From("users").
    WhereNull("deleted_at").
    OrderBy("id", "ASC").
    Build()

users, err := sqlite.QueryAll(db, sql, args, func(rows *sqlite.Rows) (User, error) {
    var u User
    err := rows.Scan(&u.ID, &u.Email, &u.Name)
    return u, err
})
```

The scan function is called once per row. It receives `*Rows` and should only call `rows.Scan(...)` to read columns into the returned value. SQLite stores booleans as integers (0/1), but `Rows.Scan` handles `*bool` natively — scan directly into bool fields:

```go
users, err := sqlite.QueryAll(db, sql, args, func(rows *sqlite.Rows) (UserJSON, error) {
    var u UserJSON
    if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.IsActive); err != nil {
        return u, err
    }
    return u, nil
})
```

`QueryAll` always returns a non-nil slice — when no rows match, it returns `[]T{}` instead of `nil`. This means the result serializes to `[]` in JSON, not `null`, avoiding frontend crashes on empty result sets.

### QueryOne — scan a single row

`QueryOne` is the single-row counterpart to `QueryAll`. It executes a query, scans the first row using the provided function, and returns a single typed value. If the query returns no rows, it returns `ErrNoRows`.

```go
sql, args := sqlite.Select("id", "email", "name").
    From("users").
    Where("id = ?", id).
    Build()

user, err := sqlite.QueryOne(db, sql, args, func(rows *sqlite.Rows) (User, error) {
    var u User
    err := rows.Scan(&u.ID, &u.Email, &u.Name)
    return u, err
})
if errors.Is(err, sqlite.ErrNoRows) {
    http.WriteError(w, http.StatusNotFound, "user not found")
    return
}
```

`QueryOne` uses the same `func(*Rows) (T, error)` scan function signature as `QueryAll`. This means you can define a scan function once and use it for both list and detail handlers:

```go
// Define once per module:
func scanUser(rows *sqlite.Rows) (UserJSON, error) {
    var u UserJSON
    if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.IsActive); err != nil {
        return u, err
    }
    return u, nil
}

// List handler — multiple rows:
users, err := sqlite.QueryAll(db, sql, args, scanUser)

// Detail handler — single row:
user, err := sqlite.QueryOne(db, sql, args, scanUser)
```

Extra rows beyond the first are ignored. For simple scalar queries (`COUNT`, existence checks), `db.QueryRow().Scan()` remains the more concise choice.

### Now — current UTC timestamp

`sqlite.Now()` returns the current UTC time as an RFC 3339 string (`2024-01-15T14:30:00Z`). Use it when storing timestamps in database columns:

```go
now := sqlite.Now()

sql, args := sqlite.Insert("users").
    Set("name", "Alice").
    Set("email", "alice@example.com").
    Set("created_at", now).
    Build()
```

This is the canonical format for `created_at`, `updated_at`, `deleted_at`, and similar columns throughout the application.

### FormatTime — convert any time.Time for database storage

`sqlite.FormatTime(t)` converts an arbitrary `time.Time` to a UTC RFC 3339 string. Use it when the timestamp is not "now" — future expiry dates, past cutoffs, or times from other sources:

```go
// Future timestamp — token expiry
expiresAt := sqlite.FormatTime(time.Now().Add(24 * time.Hour))

// Past timestamp — purge cutoff
cutoff := sqlite.FormatTime(time.Now().Add(-30 * 24 * time.Hour))

// Arbitrary time — from a struct field
startedAt := sqlite.FormatTime(job.StartedAt)
```

`sqlite.Now()` delegates to `FormatTime(time.Now())` internally, so both produce the same canonical format.

### FormatID — convert an int64 ID to string

`sqlite.FormatID(id)` converts an `int64` database ID to its string representation. Use it when an integer primary key needs to be compared against a TEXT column (`entity_id` in `refresh_tokens`, `audit_log`, etc.), passed to audit logging, or included in string slices such as CSV export rows:

```go
// Audit logging — entity ID as string
adminaudit.Log(db, r, "user.create", "user", sqlite.FormatID(id), req.Email)

// WHERE on a TEXT column — entity_id stores IDs as strings
_, _ = db.Delete(sqlite.Delete("refresh_tokens").
    Where("entity_type = 'user'").
    Where("entity_id = ?", sqlite.FormatID(id)))

// CSV export — all values must be strings
return []string{sqlite.FormatID(id), email, name, createdAt}
```

For comparing a parsed path parameter against `claims.UID`, prefer `claims.IntUID() == id` instead — it avoids the string conversion entirely.

---

## Query builder

The fluent query builder generates parameterized SQL. Every builder method returns the builder for chaining, and `.Build()` produces the SQL string and argument slice.

### SELECT

```go
sql, args := sqlite.Select("id", "name", "email").
    From("users").
    Where("active = ?", true).
    Where("role = ?", "admin").      // multiple Where = AND
    OrderBy("created_at", "DESC").
    Limit(20).
    Offset(0).
    Build()

rows, err := db.Query(sql, args...)
```

Joins are supported:

```go
sql, args := sqlite.Select("u.id", "u.name", "r.name AS role").
    From("users u").
    Join("roles r", "r.id = u.role_id").         // INNER JOIN
    LeftJoin("profiles p", "p.user_id = u.id").  // LEFT JOIN
    Where("u.active = ?", true).
    Build()
```

Aggregation with `GroupBy` and `Having`:

```go
sql, args := sqlite.Select("DATE(created_at, 'unixepoch') AS day", "COUNT(*) AS count").
    From("users").
    Where("created_at > ?", since).
    GroupBy("day").
    Having("COUNT(*) > ?", 10).
    OrderBy("day", "ASC").
    Build()
```

`GroupBy` accepts variadic columns — pass multiple at once or chain calls. Multiple `Having` calls are joined with AND:

```go
sql, args := sqlite.Select("status", "type", "COUNT(*) AS total", "AVG(duration) AS avg_dur").
    From("jobs").
    GroupBy("status", "type").
    Having("COUNT(*) > ?", 5).
    Having("AVG(duration) < ?", 1000).
    Build()
```

`Distinct` eliminates duplicate rows from the result set:

```go
sql, args := sqlite.Select("role").
    From("users").
    Distinct().
    Where("active = ?", true).
    Build()
// → SELECT DISTINCT role FROM users WHERE active = ?
```

Aggregate column helpers — `Sum`, `Avg`, `Min`, `Max` — return formatted SQL expressions for use in `Select` columns. Combine with `As` for aliased columns:

```go
sql, args := sqlite.Select(
        "status",
        sqlite.As(sqlite.Sum("amount"), "total"),
        sqlite.As(sqlite.Avg("duration"), "avg_dur"),
        sqlite.As(sqlite.Min("created_at"), "earliest"),
        sqlite.As(sqlite.Max("created_at"), "latest"),
    ).
    From("orders").
    Where("created_at > ?", since).
    GroupBy("status").
    Having("SUM(amount) > ?", 100).
    Build()
```

The helpers are simple string formatters — `Sum("amount")` returns `"SUM(amount)"`, `As(expr, alias)` returns `"expr AS alias"`. Use them directly in `Select` columns anywhere you'd write a raw aggregate expression.

### COALESCE — handling NULL columns

`Coalesce(column, fallback)` returns a `COALESCE(column, fallback)` expression. The fallback is a raw SQL literal:

```go
sql, args := sqlite.Select("id", sqlite.Coalesce("deleted_at", "''")).
    From("users").
    Build()
// → SELECT id, COALESCE(deleted_at, '') FROM users
```

`CoalesceEmpty(column)` is a convenience for the most common pattern — converting `NULL` to an empty string. Use it when scanning nullable TEXT columns into Go strings:

```go
sql, args := sqlite.Select("id", "name",
        sqlite.CoalesceEmpty("last_used_at"),
        sqlite.CoalesceEmpty("expires_at"),
        sqlite.CoalesceEmpty("revoked_at"),
    ).
    From("api_keys").
    Build()
// → SELECT id, name, COALESCE(last_used_at, ''), COALESCE(expires_at, ''), COALESCE(revoked_at, '') FROM api_keys
```

`CoalesceEmpty` works with table-qualified columns in JOINs:

```go
sqlite.Select("rt.id", sqlite.CoalesceEmpty("a.email"), sqlite.CoalesceEmpty("a.name")).
    From("refresh_tokens rt").
    LeftJoin("admins a", "rt.entity_id = CAST(a.id AS TEXT)")
```

For non-string fallbacks, use `Coalesce` directly:

```go
sqlite.Coalesce("score", "0")     // NULL → 0
sqlite.Coalesce("name", "'N/A'")  // NULL → 'N/A'
```

### COUNT

```go
sql, args := sqlite.Count("users").
    Where("active = ?", true).
    Build()

var count int64
db.QueryRow(sql, args...).Scan(&count)
```

### CountFrom

`CountFrom` creates a COUNT query by reusing the table and WHERE clauses from an existing `SelectBuilder`. This eliminates duplicated filter logic when building both a SELECT and a COUNT for paginated endpoints:

```go
// Build the SELECT with all filters
selectQ := sqlite.Select("id", "name", "email").
    From("users").
    Where("active = ?", true).
    Where("role = ?", "admin").
    OrderBy("created_at", "DESC").
    Limit(50).
    Offset(0)

// Derive the COUNT — same table and WHERE, no duplication
countQ := sqlite.CountFrom(selectQ)

// Execute both
rows, _ := db.Query(selectQ.Build())
// ... scan rows ...

var total int64
db.QueryRow(countQ.Build()).Scan(&total)
```

`CountFrom` copies the table name and all WHERE conditions. It excludes JOINs, ORDER BY, LIMIT, and OFFSET — for LEFT JOINs this is correct because they preserve all rows from the left table.

### db.Count

`db.Count` is a convenience method that combines `CountFrom`, `Build`, `QueryRow`, and `Scan` into a single call. Use it in paginated list handlers to get the total count alongside the query results:

```go
selectQ := sqlite.Select("id", "name", "email").
    From("users").
    WhereNull("deleted_at").
    WhereSearch(search, "name", "email")

total, err := db.Count(selectQ)

sql, args := selectQ.OrderBy("id", "DESC").Limit(50).Offset(0).Build()
rows, _ := db.Query(sql, args...)
```

`db.Count` calls `CountFrom` internally, so it inherits the same behavior — table and WHERE conditions are reused, ORDER BY/LIMIT/OFFSET are excluded.

### db.Insert / db.Update / db.Delete

Convenience methods that combine `Build` and `Exec` into a single call, returning the most commonly needed value:

| Method | Takes | Returns | Value |
|--------|-------|---------|-------|
| `db.Insert(ib)` | `*InsertBuilder` | `(int64, error)` | Last inserted row ID |
| `db.Update(ub)` | `*UpdateBuilder` | `(int64, error)` | Number of affected rows |
| `db.Delete(d)` | `*DeleteBuilder` | `(int64, error)` | Number of deleted rows |

```go
// Create — returns the new row ID
id, err := db.Insert(sqlite.Insert("users").
    Set("email", req.Email).
    Set("name", req.Name).
    Set("created_at", sqlite.Now()))

// Update — returns affected row count (0 means not found)
n, err := db.Update(sqlite.Update("users").
    Set("name", req.Name).
    Set("updated_at", sqlite.Now()).
    Where("id = ?", id).
    WhereNull("deleted_at"))
if n == 0 {
    // not found
}

// Delete — returns deleted row count
n, err := db.Delete(sqlite.Delete("refresh_tokens").
    Where("expires_at < ?", cutoff))
```

Use `db.Exec` directly when you need `OrIgnore`, `OnConflict`, `InsertBatch`, or raw SQL.

### INSERT

```go
id, err := db.Insert(sqlite.Insert("users").
    Set("name", "Alice").
    Set("email", "alice@example.com").
    Set("created_at", sqlite.Now()))
// id is the last inserted row ID (int64)
```

Use `OrIgnore()` to skip on conflict:

```go
sql, args := sqlite.Insert("settings").
    OrIgnore().
    Set("key", "site_name").
    Set("value", "My App").
    Build()
_, _ = db.Exec(sql, args...) // OrIgnore — use Exec directly
```

Use `OnConflict()` for upsert — insert a row, or update specific columns if it already exists:

```go
sql, args := sqlite.Insert("user_settings").
    Set("user_id", uid).
    Set("key", k).
    Set("value", v).
    Set("created_at", now).
    Set("updated_at", now).
    OnConflict(
        []string{"user_id", "key"},          // conflict columns (unique constraint)
        []string{"value", "updated_at"},     // columns to update on conflict
    ).
    Build()

// Produces:
// INSERT INTO user_settings (user_id, key, value, created_at, updated_at)
// VALUES (?, ?, ?, ?, ?)
// ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
```

The first argument lists the columns that form the unique constraint. The second argument lists the columns to update from the attempted insert row (referenced via `excluded.<col>`). `created_at` is intentionally omitted from the update list — it keeps the original value.

### INSERT BATCH

Use `InsertBatch` to insert multiple rows in a single statement. This is more efficient than looping with individual `Insert` calls — one round trip instead of N.

```go
sql, args := sqlite.InsertBatch("settings").
    Columns("key", "value", "group_name").
    Row("app.name", "Stanza", "general").
    Row("app.url", "https://stanza.dev", "general").
    Row("app.timezone", "UTC", "general").
    OrIgnore().
    Build()

_, err := db.Exec(sql, args...)

// Produces:
// INSERT OR IGNORE INTO settings (key, value, group_name)
// VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)
```

`InsertBatch` supports the same `OrIgnore()` and `OnConflict()` modifiers as `Insert`. Use `OnConflict` for batch upserts:

```go
sql, args := sqlite.InsertBatch("user_settings").
    Columns("user_id", "key", "value", "updated_at").
    Row(uid, "theme", "dark", now).
    Row(uid, "lang", "en", now).
    OnConflict(
        []string{"user_id", "key"},
        []string{"value", "updated_at"},
    ).
    Build()
```

### UPDATE

```go
n, err := db.Update(sqlite.Update("users").
    Set("name", "Bob").
    Set("updated_at", sqlite.Now()).
    Where("id = ?", 42))
// n is the number of affected rows (int64)
```

Use `SetExpr` for computed assignments that use raw SQL expressions:

```go
// Increment a counter
sql, args := sqlite.Update("api_keys").
    SetExpr("request_count", "request_count + 1").
    Set("last_used_at", time.Now().Unix()).
    Where("id = ?", keyID).
    Build()
```

```go
// Add a parameterized value
sql, args := sqlite.Update("wallets").
    SetExpr("balance", "balance + ?", amount).
    Where("id = ?", walletID).
    Build()
```

`Set` and `SetExpr` can be mixed freely in the same builder. `Set` is for literal values, `SetExpr` is for expressions.

### DELETE

```go
n, err := db.Delete(sqlite.Delete("sessions").
    Where("expires_at < ?", cutoff))
// n is the number of deleted rows (int64)
```

### WhereNull / WhereNotNull

`WhereNull` and `WhereNotNull` add `IS NULL` and `IS NOT NULL` conditions. Available on all four query builders — `Select`, `Count`, `Update`, and `Delete`:

```go
// Find users who haven't been soft-deleted
sql, args := sqlite.Select("id", "name", "email").
    From("users").
    WhereNull("deleted_at").
    Build()
// → SELECT id, name, email FROM users WHERE deleted_at IS NULL
```

```go
// Purge read notifications older than 30 days
sql, args := sqlite.Delete("notifications").
    WhereNotNull("read_at").
    Where("created_at < ?", cutoff).
    Build()
// → DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?
```

### WhereIn

`WhereIn` adds a type-safe `IN (?, ?, ...)` condition. It is available on all four query builders — `Select`, `Count`, `Update`, and `Delete`. It automatically generates the correct number of placeholders and can be mixed with regular `Where` calls:

```go
// Select by multiple IDs
sql, args := sqlite.Select("id", "name", "email").
    From("users").
    WhereIn("id", 1, 2, 3).
    Build()
// → SELECT id, name, email FROM users WHERE id IN (?, ?, ?)
```

```go
// Bulk delete with additional filter
sql, args := sqlite.Delete("sessions").
    Where("entity_type = ?", "admin").
    WhereIn("id", sessionIDs...).
    Build()
```

```go
// Bulk update
sql, args := sqlite.Update("notifications").
    Set("read_at", time.Now().Unix()).
    WhereIn("id", ids...).
    Build()
```

If `values` is empty, `WhereIn` produces `1 = 0` (always false) instead of invalid SQL. This is safe to use without checking the slice length first:

```go
// Empty slice → WHERE 1 = 0 → zero rows affected
sql, args := sqlite.Delete("items").
    WhereIn("id").  // no values
    Build()
// → DELETE FROM items WHERE 1 = 0
```

### WhereNotIn

`WhereNotIn` adds a `NOT IN (?, ?, ...)` condition — the negation of `WhereIn`. It is available on all four query builders — `Select`, `Count`, `Update`, and `Delete`:

```go
// Select users who are NOT admins or superadmins
sql, args := sqlite.Select("id", "name").
    From("users").
    WhereNotIn("role", "admin", "superadmin").
    Build()
// → SELECT id, name FROM users WHERE role NOT IN (?, ?)
```

```go
// Delete sessions for users NOT in the keep list
sql, args := sqlite.Delete("sessions").
    WhereNotIn("user_id", keepIDs...).
    Build()
```

```go
// Update users excluding specific IDs
sql, args := sqlite.Update("users").
    Set("newsletter", false).
    WhereNotIn("id", optOutIDs...).
    Build()
```

If `values` is empty, `WhereNotIn` produces `1 = 1` (always true) — everything is NOT IN an empty set. This is the semantic counterpart to `WhereIn`'s `1 = 0`:

```go
// Empty slice → WHERE 1 = 1 → all rows match
sql, args := sqlite.Select("id").
    From("users").
    WhereNotIn("id").  // no values
    Build()
// → SELECT id FROM users WHERE 1 = 1
```

### WhereSearch

`WhereSearch` adds a multi-column contains-search condition. It escapes the search term, wraps it in `%` for contains matching, and OR's across the specified columns. If the search string is empty, the condition is skipped (no-op). Available on all four query builders:

```go
search := r.URL.Query().Get("search")

q := sqlite.Select("id", "email", "name").
    From("users").
    WhereNull("deleted_at").
    WhereSearch(search, "email", "name")
// → WHERE deleted_at IS NULL AND (email LIKE '%term%' ESCAPE '\' OR name LIKE '%term%' ESCAPE '\')
```

Works with table-prefixed columns for JOIN queries:

```go
q.WhereSearch(search, "audit_log.details", "audit_log.action")
```

### WhereOr

`WhereOr` groups conditions with OR. Each `Cond` is OR'd together and the group is parenthesized so it composes correctly with other AND conditions. Requires at least 2 conditions (fewer is a no-op). Available on all four query builders:

```go
cutoff := sqlite.FormatTime(time.Now().Add(-30 * 24 * time.Hour))

sql, args := sqlite.Delete("api_keys").
    WhereOr(
        sqlite.Cond("revoked_at IS NOT NULL AND revoked_at < ?", cutoff),
        sqlite.Cond("expires_at IS NOT NULL AND expires_at < ?", cutoff),
    ).
    Build()
// → DELETE FROM api_keys WHERE (revoked_at IS NOT NULL AND revoked_at < ? OR expires_at IS NOT NULL AND expires_at < ?)
```

Combines with regular `Where` for mixed AND/OR logic:

```go
sql, args := sqlite.Select("id").
    From("tokens").
    WhereNull("deleted_at").
    WhereOr(
        sqlite.Cond("used_at IS NOT NULL"),
        sqlite.Cond("expires_at < ?", cutoff),
    ).
    Build()
// → WHERE deleted_at IS NULL AND (used_at IS NOT NULL OR expires_at < ?)
```

### WhereInSelect / WhereNotInSelect

`WhereInSelect` adds a `column IN (SELECT ...)` condition using a subquery built from another `SelectBuilder`. The subquery's SQL and arguments are merged into the outer query. `WhereNotInSelect` adds the negated `NOT IN` form. Available on all four query builders:

```go
// Find users who have at least one active session:
sub := sqlite.Select("user_id").From("sessions").Where("expires_at > ?", now)

sql, args := sqlite.Select("*").From("users").
    WhereInSelect("id", sub).
    Build()
// → SELECT * FROM users WHERE id IN (SELECT user_id FROM sessions WHERE expires_at > ?)
```

Use `WhereNotInSelect` to exclude rows matching a subquery:

```go
// Delete notifications for inactive admins:
activeSub := sqlite.Select("id").From("admins").Where("is_active = 1")

sql, args := sqlite.Delete("notifications").
    Where("entity_type = ?", "admin").
    WhereNotInSelect("entity_id", activeSub).
    Build()
// → DELETE FROM notifications WHERE entity_type = ? AND entity_id NOT IN (SELECT id FROM admins WHERE is_active = 1)
```

### WhereExists / WhereNotExists

`WhereExists` adds an `EXISTS (SELECT ...)` condition. The subquery typically uses `SELECT 1` and correlates with the outer query via a column reference. `WhereNotExists` adds the negated form. Available on all four query builders:

```go
// Find users who have placed at least one order:
sub := sqlite.Select("1").From("orders o").Where("o.user_id = u.id")

sql, args := sqlite.Select("*").From("users u").
    WhereExists(sub).
    Build()
// → SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)
```

Use `WhereNotExists` to find rows without matching related records:

```go
// Find users who have never logged in:
sub := sqlite.Select("1").From("sessions s").Where("s.user_id = u.id")

sql, args := sqlite.Select("*").From("users u").
    WhereNotExists(sub).
    Build()
// → SELECT * FROM users u WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id)
```

### EscapeLike

`EscapeLike` escapes the special characters `%`, `_`, and `\` in a string so it can be used as a literal search term in a `LIKE` clause with `ESCAPE '\'`. This prevents user input from being interpreted as wildcards. For multi-column search, prefer `WhereSearch` which calls `EscapeLike` internally:

```go
// Single-column LIKE with custom pattern (prefix match):
like := sqlite.EscapeLike(search) + "%"
q.Where("name LIKE ? ESCAPE '\\'", like)
```

Wrap the result with `%` for the matching style you need — `%term%` for contains, `term%` for prefix, `%term` for suffix. The function only escapes; it does not add wildcards.

---

## Transactions

### Manual transactions

```go
tx, err := db.Begin()
if err != nil {
    return err
}

_, err = tx.Exec("UPDATE accounts SET balance = balance - ? WHERE id = ?", 100, fromID)
if err != nil {
    tx.Rollback()
    return err
}

_, err = tx.Exec("UPDATE accounts SET balance = balance + ? WHERE id = ?", 100, toID)
if err != nil {
    tx.Rollback()
    return err
}

return tx.Commit()
```

### InTx helper

Cleaner pattern — automatically commits on success, rolls back on error:

```go
err := db.InTx(func(tx *sqlite.Tx) error {
    _, err := tx.Exec("UPDATE accounts SET balance = balance - ? WHERE id = ?", 100, fromID)
    if err != nil {
        return err
    }
    _, err = tx.Exec("UPDATE accounts SET balance = balance + ? WHERE id = ?", 100, toID)
    return err
})
```

### Builder methods on Tx

`Tx` supports the same `Insert`, `Update`, and `Delete` convenience methods as `DB` — no need to call `Build()` + `Exec()` manually:

```go
err := db.InTx(func(tx *sqlite.Tx) error {
    // Insert returns the last inserted row ID.
    orderID, err := tx.Insert(sqlite.Insert("orders").
        Set("user_id", userID).
        Set("total_cents", total).
        Set("created_at", sqlite.Now()))
    if err != nil {
        return err
    }

    // Update returns the number of affected rows.
    _, err = tx.Update(sqlite.Update("orders").
        SetExpr("total_cents", "total_cents + ?", extra).
        Where("id = ?", orderID))
    if err != nil {
        return err
    }

    // Delete returns the number of affected rows.
    _, err = tx.Delete(sqlite.Delete("temp_items").
        Where("session_id = ?", sessionID))
    return err
})
```

### Batch operations

`ExecMany` prepares a statement once and executes it for each set of arguments:

```go
err := db.InTx(func(tx *sqlite.Tx) error {
    return tx.ExecMany(
        "INSERT INTO tags (name) VALUES (?)",
        [][]any{{"go"}, {"sqlite"}, {"framework"}},
    )
})
```

---

## Migrations

Migrations are registered in code and run automatically on startup.

### Defining migrations

```go
func addMigrations(db *sqlite.DB) {
    db.AddMigration(1710892800, "create_users", func(tx *sqlite.Tx) error {
        _, err := tx.Exec(`
            CREATE TABLE users (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                email      TEXT NOT NULL UNIQUE,
                password   TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
                deleted_at INTEGER
            )
        `)
        return err
    }, nil) // nil Down function — optional
}
```

The version is a Unix timestamp. Migrations run in version order. Each migration runs in its own transaction.

### Running migrations

```go
applied, err := db.Migrate()
// applied = number of migrations that ran
```

For file-backed databases, `Migrate` automatically backs up the database before running. The backup path is available via `db.LastBackupPath()`.

### Rollback

```go
version, err := db.Rollback()
// version = the migration version that was reversed (0 if none)
```

Rollback reverses the last applied migration using its `Down` function.

### Backup

```go
err := db.Backup("/path/to/backup.sqlite")
```

`Backup` uses `VACUUM INTO` to create a complete, consistent copy of the database. Unlike a raw file copy, it includes all WAL data and produces a compacted, defragmented file. Safe to call while the database is in use. If the destination file already exists, it is removed first.

### Optimize

```go
err := db.Optimize()
```

`Optimize` runs `PRAGMA optimize`, which updates query planner statistics for tables that SQLite has identified as needing them. Call this before closing a long-running database connection — it keeps the query planner accurate with minimal overhead (typically a few milliseconds). In the standalone app, this runs automatically during graceful shutdown.

---

## Error handling

```go
var sqlite.ErrNoRows  // returned by Row.Scan when query returns no rows
```

Check for "not found" consistently:

```go
err := db.QueryRow("SELECT name FROM users WHERE id = ?", id).Scan(&name)
if err == sqlite.ErrNoRows {
    http.WriteError(w, http.StatusNotFound, "user not found")
    return
}
if err != nil {
    http.WriteServerError(w, r, "database error", err)
    return
}
```

### Structured errors

All SQLite errors are returned as `*sqlite.Error` with the result code and extended result code from SQLite. Use the helper functions for common checks:

```go
_, err := db.Exec("INSERT INTO users (email, ...) VALUES (?, ...)", email, ...)
if sqlite.IsUniqueConstraintError(err) {
    http.WriteError(w, http.StatusConflict, "email already exists")
    return
}
if err != nil {
    http.WriteServerError(w, r, "database error", err)
    return
}
```

| Function | Matches |
|----------|---------|
| `IsConstraintError(err)` | Any constraint violation (UNIQUE, FOREIGN KEY, NOT NULL, CHECK, PRIMARY KEY) |
| `IsUniqueConstraintError(err)` | UNIQUE constraint — duplicate value in a unique column |
| `IsForeignKeyConstraintError(err)` | FOREIGN KEY constraint — referenced row missing |
| `IsNotNullConstraintError(err)` | NOT NULL constraint — required column is NULL |

For advanced cases, extract the full error with `errors.As`:

```go
var sqlErr *sqlite.Error
if errors.As(err, &sqlErr) {
    log.Info("sqlite error", "code", sqlErr.Code, "extended", sqlErr.ExtendedCode)
}
```

---

## Scan types

`Scan` supports these destination types:

| Type | SQLite type |
|------|-------------|
| `*int`, `*int64` | INTEGER |
| `*float64` | FLOAT |
| `*string` | TEXT |
| `*[]byte` | BLOB |
| `*bool` | INTEGER (0/1) |
| `*any` | Any (auto-detected) |
