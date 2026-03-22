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

`Start` opens **1 write connection** and a **pool of read connections** (default 4), applying default PRAGMAs to all (WAL mode, memory-mapped I/O, optimized cache). The read pool lets multiple HTTP requests query the database simultaneously — each `Query` takes a connection from the pool, and `Rows.Close` returns it. Writes (`Exec`, transactions) use the dedicated write connection. `Stop` drains and closes all pool connections, then the write connection.

Use `WithReadPoolSize(n)` to tune the pool size. The default of 4 handles typical web workloads well. Increase it if profiling shows read contention under high concurrency.

For in-memory databases (`:memory:`), a single connection is used because each open creates a separate database.

In a Stanza app, the database is wired through the lifecycle — it starts first and stops last.

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

### INSERT

```go
sql, args := sqlite.Insert("users").
    Set("name", "Alice").
    Set("email", "alice@example.com").
    Set("created_at", time.Now().Unix()).
    Build()

result, err := db.Exec(sql, args...)
```

Use `OrIgnore()` to skip on conflict:

```go
sql, args := sqlite.Insert("settings").
    OrIgnore().
    Set("key", "site_name").
    Set("value", "My App").
    Build()
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
sql, args := sqlite.Update("users").
    Set("name", "Bob").
    Set("updated_at", time.Now().Unix()).
    Where("id = ?", 42).
    Build()

result, err := db.Exec(sql, args...)
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
sql, args := sqlite.Delete("sessions").
    Where("expires_at < ?", time.Now().Unix()).
    Build()

result, err := db.Exec(sql, args...)
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

### WhereSearch

`WhereSearch` adds a multi-column contains-search condition. It escapes the search term, wraps it in `%` for contains matching, and OR's across the specified columns. If the search string is empty, the condition is skipped (no-op). Available on all four query builders:

```go
search := r.URL.Query().Get("search")

q := sqlite.Select("id", "email", "name").
    From("users").
    Where("deleted_at IS NULL").
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
cutoff := time.Now().UTC().Add(-30 * 24 * time.Hour).Format(time.RFC3339)

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
    Where("deleted_at IS NULL").
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
    http.WriteError(w, http.StatusInternalServerError, "database error")
    return
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
