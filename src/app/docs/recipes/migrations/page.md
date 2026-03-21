---
title: Database migrations
nextjs:
  metadata:
    title: Database migrations
    description: How to create and manage SQLite schema changes with Go-based migrations.
---

Stanza migrations are Go functions — not SQL files. They run automatically on boot, in a transaction, with automatic rollback on failure. Before running, the framework copies the SQLite file to `/tmp` as a safety backup.

---

## Where migrations live

All migrations are registered in `api/migration/migration.go`:

```go
package migration

import "github.com/stanza-go/framework/pkg/sqlite"

func Register(db *sqlite.DB) {
    db.AddMigration(1742428800, "create_settings", createSettingsUp, createSettingsDown)
    db.AddMigration(1742428801, "create_admins", createAdminsUp, createAdminsDown)
    db.AddMigration(1742428802, "create_users", createUsersUp, createUsersDown)
    // add new migrations here
}
```

---

## Adding a new table

Use a Unix timestamp as the version number. Get one with `date +%s` in your terminal:

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

---

## Adding a column

```go
db.AddMigration(1742600000, "add_product_sku", addProductSKUUp, addProductSKUDown)
```

```go
func addProductSKUUp(tx *sqlite.Tx) error {
    _, err := tx.Exec(`ALTER TABLE products ADD COLUMN sku TEXT NOT NULL DEFAULT ''`)
    return err
}

func addProductSKUDown(tx *sqlite.Tx) error {
    _, err := tx.Exec(`ALTER TABLE products DROP COLUMN sku`)
    return err
}
```

---

## Adding an index

```go
db.AddMigration(1742700000, "add_product_name_index", addProductNameIndexUp, addProductNameIndexDown)
```

```go
func addProductNameIndexUp(tx *sqlite.Tx) error {
    _, err := tx.Exec(`CREATE INDEX idx_products_name ON products(name) WHERE deleted_at IS NULL`)
    return err
}

func addProductNameIndexDown(tx *sqlite.Tx) error {
    _, err := tx.Exec(`DROP INDEX IF EXISTS idx_products_name`)
    return err
}
```

{% callout title="Partial indexes" %}
Use `WHERE deleted_at IS NULL` on indexes for soft-deleted tables. This keeps the index small and efficient — you almost never query deleted rows.
{% /callout %}

---

## Seeding data

Seed data lives in `api/seed/seed.go` and runs after migrations on boot. Use it for default admin accounts, initial settings, or reference data:

```go
func Run(db *sqlite.DB, logger *log.Logger) error {
    // Check if admin already exists.
    var count int
    _ = db.QueryRow("SELECT COUNT(*) FROM admins").Scan(&count)
    if count > 0 {
        return nil
    }

    // Create default admin.
    hash, err := auth.HashPassword("admin")
    if err != nil {
        return err
    }
    _, err = db.Exec(
        "INSERT INTO admins (email, password, name, role) VALUES (?, ?, ?, ?)",
        "admin@stanza.dev", hash, "Admin", "superadmin",
    )
    return err
}
```

Seeds are idempotent — they check for existing data before inserting.

---

## How migrations run

1. On boot, `db.Migrate()` is called after `migration.Register(db)`.
2. The framework checks the `_migrations` table for already-applied versions.
3. Pending migrations run in order (sorted by timestamp) inside transactions.
4. If a migration fails, the transaction rolls back and the app exits with an error.
5. Before running any migrations, the SQLite file is copied to `/tmp` as a backup.

---

## Conventions

| Convention | Detail |
|------------|--------|
| Version numbers | Unix timestamps (`date +%s`), not sequential |
| Function names | `{action}{Table}Up` / `{action}{Table}Down` |
| Every migration has up and down | Even if down is just `DROP TABLE` |
| Transactions are automatic | Each migration runs in its own `*sqlite.Tx` |
| Timestamps as TEXT | `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` for defaults |
| Booleans as INTEGER | `0` / `1`, not `true` / `false` |
| Soft delete column | `deleted_at TEXT` nullable, `NULL` = not deleted |

---

## Tips

- **Never modify an existing migration** once it's been applied. Add a new migration instead.
- **Keep migrations simple.** One table or one alteration per migration.
- **Test migrations** by deleting your local database and restarting. All migrations re-run from scratch.
- **SQLite limitations:** `ALTER TABLE` can add columns and drop columns, but cannot rename columns or change types. For complex changes, create a new table, copy data, and drop the old one.
