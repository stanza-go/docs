---
title: Database schema design
nextjs:
  metadata:
    title: Database schema design
    description: Schema conventions, indexing strategies, and evolution patterns for SQLite tables in Stanza.
---

This recipe covers the design decisions behind Stanza's database schemas — column types, naming, indexes, constraints, and how to evolve schemas safely over time. For the mechanics of writing and running migrations, see [Database migrations](/recipes/migrations).

---

## Column types

SQLite has flexible typing, but Stanza uses strict conventions so the AI always produces consistent schemas:

| Go type | SQLite column | Default expression | Notes |
|---------|--------------|-------------------|-------|
| `int64` (ID) | `INTEGER PRIMARY KEY AUTOINCREMENT` | — | Always the first column |
| `string` | `TEXT NOT NULL` | `DEFAULT ''` | Empty string, not NULL |
| `bool` | `INTEGER NOT NULL` | `DEFAULT 0` or `DEFAULT 1` | 0 = false, 1 = true |
| `int` / `int64` | `INTEGER NOT NULL` | `DEFAULT 0` | Counts, amounts, flags |
| `time.Time` | `TEXT NOT NULL` | `DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))` | ISO 8601 UTC |
| nullable `time.Time` | `TEXT` | — | NULL means "not set" (e.g., `deleted_at`) |
| `float64` | `REAL NOT NULL` | `DEFAULT 0.0` | Rare — prefer integer cents for money |
| JSON blob | `TEXT NOT NULL` | `DEFAULT '{}'` | Stored as JSON string, parsed in Go |

{% callout title="Prefer NOT NULL" %}
Every column should be `NOT NULL` with a sensible default unless NULL carries specific meaning. NULL columns require `sql.NullString` or pointer types in Go and complicate query logic. The two common exceptions are `deleted_at` (soft deletes) and `completed_at` (nullable timestamps marking an event).
{% /callout %}

---

## Naming conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Table | Plural snake_case | `users`, `api_keys`, `webhook_deliveries` |
| Column | Singular snake_case | `email`, `is_active`, `created_at` |
| Primary key | `id` | Always `INTEGER PRIMARY KEY AUTOINCREMENT` |
| Foreign key | `{singular_table}_id` | `user_id`, `webhook_id`, `role_id` |
| Boolean | `is_` or `has_` prefix | `is_active`, `is_system`, `has_verified` |
| Timestamp | `_at` suffix | `created_at`, `updated_at`, `deleted_at`, `expires_at` |
| Index | `idx_{table}_{columns}` | `idx_users_email`, `idx_api_keys_entity` |
| Unique constraint | Inline `UNIQUE` or `UNIQUE(col1, col2)` | `email TEXT NOT NULL UNIQUE` |

---

## Standard table template

Every table in the standalone app follows this structure:

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
    if err != nil {
        return err
    }
    _, err = tx.Exec(`CREATE INDEX idx_products_name ON products(name) WHERE deleted_at IS NULL`)
    return err
}
```

Key details:

- `id` is always first, `created_at` / `updated_at` / `deleted_at` are always last
- Business columns go in the middle, ordered by importance
- `updated_at` is set by the application on every UPDATE — there is no SQLite trigger
- `deleted_at` is nullable (`TEXT` without `NOT NULL`) — NULL means the row is active

---

## Soft deletes

Most tables use soft deletes instead of `DELETE FROM`. The pattern:

```go
// Soft delete — set deleted_at, never remove the row.
n, err := db.Update(sqlite.Update("products").
    Set("deleted_at", sqlite.Now()).
    Where("id = ?", id))
```

Queries filter out deleted rows by default:

```go
// List active products only.
sql, args := sqlite.Select("id", "name", "price_cents").
    From("products").
    WhereNull("deleted_at").
    OrderBy("created_at", "DESC").
    Build()
```

Index deleted rows out with a partial index:

```sql
CREATE INDEX idx_products_name ON products(name) WHERE deleted_at IS NULL
```

The partial index only contains active rows. It is smaller, faster to scan, and automatically excludes deleted rows from lookups — which is how the app queries 99% of the time.

---

## Indexing strategies

### When to add an index

Add an index when a column appears in:

- `WHERE` clauses on tables with more than a few hundred rows
- `JOIN` conditions (foreign key columns)
- `ORDER BY` on large result sets
- `UNIQUE` constraints (SQLite creates an implicit index)

Do not index columns that are only used in `INSERT` or `UPDATE SET` — indexes slow writes.

### Single-column indexes

The most common pattern. Index the columns you filter and sort by:

```sql
CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at)
CREATE INDEX idx_cron_runs_job_name ON cron_runs(job_name)
```

### Composite indexes

Use when queries filter on multiple columns together. Column order matters — put the most selective column first:

```sql
-- Queries: WHERE entity_type = ? AND entity_id = ?
CREATE INDEX idx_refresh_tokens_entity ON refresh_tokens(entity_type, entity_id)

-- Queries: WHERE entity_type = ? AND entity_id = ? AND read_at IS NULL
CREATE INDEX idx_notifications_unread ON notifications(entity_type, entity_id, read_at)
    WHERE read_at IS NULL
```

A composite index on `(a, b, c)` satisfies queries on `(a)`, `(a, b)`, and `(a, b, c)` — but not `(b)` or `(c)` alone. This is the leftmost prefix rule.

### Partial indexes

Filter the index itself with a `WHERE` clause. Use for:

- **Soft deletes:** `WHERE deleted_at IS NULL` — excludes deleted rows from the index
- **Status filtering:** `WHERE status = 'pending'` — small index for active-state lookups
- **Unread notifications:** `WHERE read_at IS NULL` — only unread rows in the index

```sql
-- Only index active API keys.
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash) WHERE revoked_at IS NULL

-- Only index unread notifications per entity.
CREATE INDEX idx_notifications_unread ON notifications(entity_type, entity_id, read_at)
    WHERE read_at IS NULL
```

Partial indexes are smaller and faster than full indexes because they exclude rows that queries never match.

### Index naming

Always use `idx_{table}_{columns}`:

```sql
CREATE INDEX idx_users_email ON users(email)
CREATE INDEX idx_api_keys_entity ON api_keys(entity_type, entity_id)
CREATE INDEX idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id)
```

---

## Foreign keys and relationships

Enable foreign keys (the framework does this on startup via `PRAGMA foreign_keys = ON`):

### One-to-many

```sql
CREATE TABLE webhook_deliveries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event      TEXT    NOT NULL,
    payload    TEXT    NOT NULL DEFAULT '{}',
    status     TEXT    NOT NULL DEFAULT 'pending',
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
)
CREATE INDEX idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id)
```

`ON DELETE CASCADE` means deleting a webhook automatically deletes all its deliveries. Always index foreign key columns — without an index, SQLite does a full table scan on the child table when deleting a parent row.

### Many-to-many (junction table)

```sql
CREATE TABLE role_scopes (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    scope   TEXT    NOT NULL,
    UNIQUE(role_id, scope)
)
CREATE INDEX idx_role_scopes_role_id ON role_scopes(role_id)
```

The `UNIQUE(role_id, scope)` constraint prevents duplicate assignments. The index on `role_id` supports the common query: "get all scopes for this role."

### Polymorphic associations

Some tables store references to multiple entity types using a discriminator:

```sql
CREATE TABLE refresh_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT    NOT NULL DEFAULT 'admin',
    entity_id   INTEGER NOT NULL,
    token_hash  TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
)
CREATE INDEX idx_refresh_tokens_entity ON refresh_tokens(entity_type, entity_id)
```

The `entity_type` column (`'admin'`, `'user'`, `'device'`) determines which table `entity_id` refers to. This avoids separate `admin_refresh_tokens` and `user_refresh_tokens` tables. The standalone app uses this pattern for refresh tokens, uploads, notifications, API keys, and audit log entries.

{% callout title="No foreign key enforcement" %}
Polymorphic columns cannot use `REFERENCES` because the target table varies. Referential integrity is enforced in application code instead. Use this pattern only when the same table genuinely serves multiple entity types.
{% /callout %}

---

## Unique constraints

### Single column

```sql
CREATE TABLE users (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT    NOT NULL UNIQUE
)
```

### Composite unique

```sql
CREATE TABLE user_settings (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key     TEXT    NOT NULL,
    value   TEXT    NOT NULL DEFAULT '',
    UNIQUE(user_id, key)
)
```

This ensures each user has at most one value per setting key. Handle conflicts in the handler:

```go
_, err := db.Insert(sqlite.Insert("user_settings").
    Set("user_id", userID).
    Set("key", key).
    Set("value", value))
if err != nil && strings.Contains(err.Error(), "UNIQUE constraint") {
    http.WriteError(w, 409, "setting already exists")
    return
}
```

---

## Schema evolution

### Non-breaking changes

These changes are safe to apply to a running system:

| Change | SQL |
|--------|-----|
| Add a column with default | `ALTER TABLE t ADD COLUMN c TYPE NOT NULL DEFAULT v` |
| Add an index | `CREATE INDEX idx_t_c ON t(c)` |
| Drop an index | `DROP INDEX IF EXISTS idx_t_c` |
| Add a table | `CREATE TABLE t (...)` |
| Drop a table | `DROP TABLE IF EXISTS t` |

Adding a column with a `NOT NULL DEFAULT` is safe because existing rows get the default value immediately.

### Breaking changes

These require a table rebuild because SQLite does not support `ALTER TABLE RENAME COLUMN` or `ALTER TABLE ALTER COLUMN`:

1. Create the new table with the desired schema
2. Copy data from the old table
3. Drop the old table
4. Rename the new table

```go
func renameColumnUp(tx *sqlite.Tx) error {
    _, err := tx.Exec(`CREATE TABLE users_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        email      TEXT    NOT NULL UNIQUE,
        full_name  TEXT    NOT NULL DEFAULT '',
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`)
    if err != nil {
        return err
    }

    _, err = tx.Exec(`INSERT INTO users_new (id, email, full_name, created_at)
        SELECT id, email, name, created_at FROM users`)
    if err != nil {
        return err
    }

    _, err = tx.Exec(`DROP TABLE users`)
    if err != nil {
        return err
    }

    _, err = tx.Exec(`ALTER TABLE users_new RENAME TO users`)
    if err != nil {
        return err
    }

    _, err = tx.Exec(`CREATE INDEX idx_users_email ON users(email)`)
    return err
}
```

{% callout title="Re-create indexes" %}
Dropping a table drops its indexes. After the rename, re-create all indexes that the original table had.
{% /callout %}

### Data backfills

When adding a column that needs values computed from existing data, do it in the same migration:

```go
func addAPIKeyEntityUp(tx *sqlite.Tx) error {
    _, err := tx.Exec(`ALTER TABLE api_keys ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'admin'`)
    if err != nil {
        return err
    }

    _, err = tx.Exec(`ALTER TABLE api_keys ADD COLUMN entity_id TEXT NOT NULL DEFAULT ''`)
    if err != nil {
        return err
    }

    // Backfill: copy created_by into entity_id for existing rows.
    _, err = tx.Exec(`UPDATE api_keys SET entity_id = CAST(created_by AS TEXT) WHERE entity_id = ''`)
    if err != nil {
        return err
    }

    _, err = tx.Exec(`CREATE INDEX idx_api_keys_entity ON api_keys(entity_type, entity_id)`)
    return err
}
```

The entire migration runs in a transaction. If the backfill fails, everything rolls back — the columns are not added half-populated.

---

## Key-value settings table

For runtime-configurable settings that don't belong in `config.yaml`:

```sql
CREATE TABLE settings (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    key   TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL DEFAULT '',
    group_name TEXT NOT NULL DEFAULT 'general'
)
```

Query by key:

```go
var value string
sql, args := sqlite.Select("value").From("settings").Where("key = ?", "site_name").Build()
err := db.QueryRow(sql, args...).Scan(&value)
```

This pattern is used for the admin settings page. Group by `group_name` for categorized display. The admin panel renders each group as a card with inline-editable fields.

---

## The rules

1. **Every column is `NOT NULL` with a default** unless NULL carries meaning.
2. **Timestamps are `TEXT` in ISO 8601 UTC.** Use `strftime` for defaults, `time.RFC3339` in Go.
3. **Booleans are `INTEGER`** — `0` or `1`, with `is_` prefix.
4. **Index every foreign key column.** Without it, cascade deletes do full table scans.
5. **Use partial indexes for soft deletes.** `WHERE deleted_at IS NULL` keeps the index small.
6. **One concern per migration.** Add a table, add a column, add an index — not all three.
7. **Never modify an applied migration.** Add a new one instead.
8. **Table rebuilds for breaking changes.** Create new → copy data → drop old → rename.
9. **Backfill in the same migration.** The transaction ensures all-or-nothing.
10. **Use `UNIQUE` constraints, not application-level checks.** The database is the last line of defense.
