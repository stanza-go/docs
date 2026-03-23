---
title: Database transactions
nextjs:
  metadata:
    title: Database transactions
    description: When to use SQLite transactions, the InTx helper, batch operations, and SQLite-specific gotchas.
---

SQLite serializes all writes through a single connection. Most handlers need only one write — no transaction required. Transactions earn their place when multiple writes must succeed or fail together.

---

## When you don't need a transaction

Most Stanza handlers perform independent operations. If one fails, the others still make sense on their own:

```go
func deleteHandler(db *sqlite.DB, wh *webhooks.Dispatcher) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        id, ok := http.PathParamInt64(w, r, "id")
        if !ok {
            return
        }

        // Soft-delete the user.
        n, err := db.Update(sqlite.Update("users").
            Set("deleted_at", sqlite.Now()).
            Set("is_active", 0).
            Where("id = ?", id).
            WhereNull("deleted_at"))
        if err != nil {
            http.WriteServerError(w, r, "failed to delete user", err)
            return
        }
        if n == 0 {
            http.WriteError(w, http.StatusNotFound, "user not found")
            return
        }

        // Revoke sessions — best-effort, failure is acceptable.
        _, _ = db.Delete(sqlite.Delete("refresh_tokens").
            Where("entity_type = ?", "user").
            Where("entity_id = ?", id))

        // Audit and webhook — fire-and-forget.
        adminaudit.Log(db, r, "user.delete", "user", id, "")
        _ = wh.Dispatch(r.Context(), "user.deleted", map[string]any{"user_id": id})

        http.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
    }
}
```

The soft-delete is the only critical write. Revoking sessions, logging audit entries, and dispatching webhooks are independent — if any fails, the delete still happened and the response is correct.

{% callout title="Rule of thumb" %}
If the handler would return the same status code regardless of which secondary writes fail, you don't need a transaction. Use `_, _ = db.Exec(...)` to make the intent explicit.
{% /callout %}

---

## InTx: the preferred pattern

When multiple writes must be atomic, use `db.InTx()`. It begins a transaction, calls your function, commits on success, and rolls back on error or panic:

```go
err := db.InTx(func(tx *sqlite.Tx) error {
    // Debit the source account.
    n, err := tx.Update(sqlite.Update("accounts").
        SetExpr("balance", "balance - ?", amount).
        Where("id = ?", fromID))
    if err != nil {
        return err
    }
    if n == 0 {
        return errors.New("source account not found")
    }

    // Credit the destination account.
    n, err = tx.Update(sqlite.Update("accounts").
        SetExpr("balance", "balance + ?", amount).
        Where("id = ?", toID))
    if err != nil {
        return err
    }
    if n == 0 {
        return errors.New("destination account not found")
    }

    // Record the transfer.
    _, err = tx.Insert(sqlite.Insert("transfers").
        Set("from_id", fromID).
        Set("to_id", toID).
        Set("amount", amount).
        Set("created_at", sqlite.Now()))
    return err
})
if err != nil {
    http.WriteServerError(w, r, "failed to transfer", err)
    return
}
```

All three writes succeed together or none of them do. If any `tx.Exec` returns an error, `InTx` rolls back automatically.

---

## Manual Begin / Commit / Rollback

Use manual transactions when you need more control — for example, when error handling differs between steps:

```go
tx, err := db.Begin()
if err != nil {
    http.WriteServerError(w, r, "failed to begin transaction", err)
    return
}
defer tx.Rollback() // Safe to call after Commit — it's a no-op.

orderID, err := tx.Insert(sqlite.Insert("orders").
    Set("user_id", userID).
    Set("total_cents", total).
    Set("created_at", sqlite.Now()))
if err != nil {
    http.WriteServerError(w, r, "failed to create order", err)
    return
}

for _, item := range items {
    if _, err := tx.Insert(sqlite.Insert("order_items").
        Set("order_id", orderID).
        Set("product_id", item.ProductID).
        Set("quantity", item.Quantity).
        Set("price_cents", item.Price)); err != nil {
        http.WriteServerError(w, r, "failed to add order item", err)
        return
    }
}

if err := tx.Commit(); err != nil {
    http.WriteServerError(w, r, "failed to commit order", err)
    return
}
```

The `defer tx.Rollback()` pattern is safe — `Rollback` is a no-op after a successful `Commit`.

---

## Batch inserts with ExecMany

When inserting many rows with the same SQL, `ExecMany` prepares the statement once and reuses it for each row. It must be called inside a transaction:

```go
err := db.InTx(func(tx *sqlite.Tx) error {
    return tx.ExecMany(
        "INSERT INTO tags (name, category, created_at) VALUES (?, ?, ?)",
        [][]any{
            {"go", "language", now},
            {"sqlite", "database", now},
            {"http", "protocol", now},
        },
    )
})
```

`ExecMany` fails on the first error and stops — combined with `InTx`, this means either all rows are inserted or none are.

---

## Querying inside a transaction

Transactions support `Query`, `QueryRow`, and `Exec`. When querying inside a transaction, close rows before performing writes:

```go
err := db.InTx(func(tx *sqlite.Tx) error {
    // Read all pending items.
    sql, args := sqlite.Select("id", "amount").
        From("pending_items").
        Where("status = ?", "pending").
        Build()
    rows, err := tx.Query(sql, args...)
    if err != nil {
        return err
    }

    type item struct {
        ID     int64
        Amount int
    }
    var items []item
    for rows.Next() {
        var it item
        if err := rows.Scan(&it.ID, &it.Amount); err != nil {
            rows.Close()
            return err
        }
        items = append(items, it)
    }
    rows.Close() // Close before writing.
    if err := rows.Err(); err != nil {
        return err
    }

    // Now write based on what we read.
    for _, it := range items {
        if _, err := tx.Update(sqlite.Update("pending_items").
            Set("status", "processed").
            Where("id = ?", it.ID)); err != nil {
            return err
        }
    }

    return nil
})
```

{% callout title="Close rows before writing" type="warning" %}
Inside a transaction, `Query` and `Exec` share the same connection. You must close rows before calling `Exec`, or the connection will deadlock. Collect results into a slice first, close rows, then write.
{% /callout %}

---

## Transactions in migrations

Migrations automatically run inside a transaction. The function receives a `*sqlite.Tx`:

```go
func createOrdersUp(tx *sqlite.Tx) error {
    _, err := tx.Exec(`CREATE TABLE orders (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        total_cents INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`)
    if err != nil {
        return err
    }
    _, err = tx.Exec(`CREATE INDEX idx_orders_user_id ON orders(user_id)`)
    return err
}
```

If any statement fails, the entire migration rolls back and the app exits with an error. You don't call `Begin` or `Commit` in migration functions — the framework handles that.

---

## Error handling

Errors from `tx.Exec` and `tx.Query` are the same `*sqlite.Error` type used outside transactions. Use the same helpers:

```go
err := db.InTx(func(tx *sqlite.Tx) error {
    _, err := tx.Insert(sqlite.Insert("users").
        Set("email", email).
        Set("name", name))
    return err
})
if err != nil {
    if sqlite.IsUniqueConstraintError(err) {
        http.WriteError(w, http.StatusConflict, "email already exists")
        return
    }
    http.WriteServerError(w, r, "failed to create user", err)
    return
}
```

Handle errors after `InTx` returns, not inside the closure. Inside, just return the error — `InTx` rolls back and surfaces it.

---

## SQLite-specific behavior

| Behavior | Detail |
|----------|--------|
| Write serialization | SQLite has a single write connection. `Begin()` acquires an exclusive mutex — no other writes can happen until `Commit` or `Rollback`. |
| Read independence | Read queries outside the transaction use a separate read pool. Reads are not blocked by an active transaction. |
| Keep transactions short | The write mutex is held for the entire transaction lifetime. Long transactions block all other writes. |
| No nested transactions | SQLite does not support `BEGIN` inside `BEGIN`. Calling `db.Begin()` inside an existing transaction will deadlock. |
| Panic safety | `InTx` defers a panic recovery that rolls back the transaction before re-panicking. Resources are always cleaned up. |
| Rollback is idempotent | `tx.Rollback()` after `tx.Commit()` is safe — it returns `nil` and does nothing. This makes `defer tx.Rollback()` always correct. |

---

## The rules

1. **Default to no transaction.** Most handlers do one critical write. Secondary operations (audit, webhooks, session cleanup) are independent and best-effort.

2. **Use `InTx` for atomicity.** When two or more writes must succeed together or not at all — transfers, order + items, batch imports — wrap them in `InTx`.

3. **Close rows before writing.** Inside a transaction, `Query` and `Exec` share one connection. Collect results, close rows, then write.

4. **Keep transactions short.** The write mutex is held the entire time. Do validation and preparation outside the transaction, only wrap the writes.

5. **Handle errors outside `InTx`.** Return errors from the closure — handle constraint violations, not-found, and 500s after `InTx` returns.

6. **Use `ExecMany` for batch inserts.** It prepares once, executes many times. Always use inside a transaction for all-or-nothing semantics.

7. **Use `defer tx.Rollback()` with manual transactions.** It's always safe and guarantees cleanup on early returns and panics.
