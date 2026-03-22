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
    sqlite.WithPragma("cache_size=-20000"), // custom PRAGMA
)

// Open and configure (WAL mode, mmap, etc.)
if err := db.Start(ctx); err != nil {
    return err
}
defer db.Stop(ctx)
```

`Start` opens the connection and applies default PRAGMAs for performance (WAL mode, memory-mapped I/O, optimized cache). `Stop` closes the connection gracefully.

In a Stanza app, the database is wired through the lifecycle — it starts first and stops last.

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

### UPDATE

```go
sql, args := sqlite.Update("users").
    Set("name", "Bob").
    Set("updated_at", time.Now().Unix()).
    Where("id = ?", 42).
    Build()

result, err := db.Exec(sql, args...)
```

### DELETE

```go
sql, args := sqlite.Delete("sessions").
    Where("expires_at < ?", time.Now().Unix()).
    Build()

result, err := db.Exec(sql, args...)
```

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
