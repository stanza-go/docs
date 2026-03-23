---
title: Bulk operations
nextjs:
  metadata:
    title: Bulk operations
    description: Patterns for bulk delete, revoke, retry, and batch upsert operations with validation and audit logging.
---

This recipe covers every bulk operation pattern used in the standalone app — soft-delete, hard-delete, state changes, loop-based service calls, and batch upserts. Each pattern validates input with `http.CheckBulkIDs`, executes the operation, logs an audit trail, and returns an `affected` count.

---

## Validation with CheckBulkIDs

Every bulk handler starts the same way — parse the request body and validate the ID list:

```go
var req struct {
    IDs []int64 `json:"ids"`
}
if err := http.ReadJSON(r, &req); err != nil {
    http.WriteError(w, http.StatusBadRequest, "invalid request body")
    return
}
if !http.CheckBulkIDs(w, req.IDs, 100) {
    return
}
```

`CheckBulkIDs` writes a 400 error and returns `false` if the slice is empty or exceeds the maximum. The caller returns immediately when `false` — no further logic runs.

The standard maximum is **100 IDs per request**. This prevents oversized SQL `IN` clauses and keeps the operation fast. Adjust the limit if your use case genuinely needs more, but 100 covers every admin panel use case.

---

## Converting IDs for WhereIn

The query builder's `WhereIn` accepts `[]any`, so convert the `[]int64` before building the query:

```go
ids := make([]any, len(req.IDs))
for i, id := range req.IDs {
    ids[i] = id
}
```

This conversion appears in every set-based bulk handler. Loop-based handlers (like queue retry) skip it because they operate on individual IDs.

---

## Bulk soft-delete

The most common pattern. Set `deleted_at` on matching rows without removing them from the database:

```go
func bulkDeleteHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        var req struct {
            IDs []int64 `json:"ids"`
        }
        if err := http.ReadJSON(r, &req); err != nil {
            http.WriteError(w, http.StatusBadRequest, "invalid request body")
            return
        }
        if !http.CheckBulkIDs(w, req.IDs, 100) {
            return
        }

        now := sqlite.Now()
        ids := make([]any, len(req.IDs))
        for i, id := range req.IDs {
            ids[i] = id
        }

        query, args := sqlite.Update("users").
            Set("deleted_at", now).
            Set("is_active", 0).
            Set("updated_at", now).
            WhereNull("deleted_at").
            WhereIn("id", ids...).
            Build()
        result, err := db.Exec(query, args...)
        if err != nil {
            http.WriteServerError(w, r, "failed to bulk delete users", err)
            return
        }

        for _, id := range req.IDs {
            adminaudit.Log(db, r, "user.delete", "user",
                strconv.FormatInt(id, 10), "bulk")
        }

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "ok":       true,
            "affected": result.RowsAffected,
        })
    }
}
```

The `WhereNull("deleted_at")` guard prevents double-deleting already-deleted rows. `RowsAffected` reflects only the rows that actually changed, so the client knows how many were genuinely deleted.

Register on a POST route:

```go
admin.HandleFunc("POST /users/bulk-delete", bulkDeleteHandler(db))
```

All bulk operations use **POST**, not DELETE — the request carries a JSON body with IDs.

---

## Bulk soft-delete with session revocation

When deleting users or admins, revoke their active sessions so they're logged out immediately:

```go
// After the UPDATE query succeeds:

// Revoke sessions for deleted users.
for _, id := range req.IDs {
    idStr := strconv.FormatInt(id, 10)
    sql, a := sqlite.Delete("refresh_tokens").
        Where("entity_type = 'user'").
        Where("entity_id = ?", idStr).
        Build()
    _, _ = db.Exec(sql, a...)
}

// Audit log each deletion.
for _, id := range req.IDs {
    adminaudit.Log(db, r, "user.delete", "user",
        strconv.FormatInt(id, 10), "bulk")
}
```

Session errors are intentionally ignored with `_, _` — if the refresh token table doesn't have a matching row, there's nothing to revoke and that's fine.

---

## Bulk hard-delete with FK cleanup

When the table has child records (foreign key relationships), delete children first:

```go
func bulkDeleteHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        var req struct {
            IDs []int64 `json:"ids"`
        }
        if err := http.ReadJSON(r, &req); err != nil {
            http.WriteError(w, http.StatusBadRequest, "invalid request body")
            return
        }
        if !http.CheckBulkIDs(w, req.IDs, 100) {
            return
        }

        ids := make([]any, len(req.IDs))
        for i, id := range req.IDs {
            ids[i] = id
        }

        // Delete child records first (FK constraint).
        dq, da := sqlite.Delete("webhook_deliveries").
            WhereIn("webhook_id", ids...).
            Build()
        _, _ = db.Exec(dq, da...)

        // Delete parent records.
        dq, da = sqlite.Delete("webhooks").
            WhereIn("id", ids...).
            Build()
        result, err := db.Exec(dq, da...)
        if err != nil {
            http.WriteServerError(w, r, "failed to bulk delete webhooks", err)
            return
        }

        for _, id := range req.IDs {
            adminaudit.Log(db, r, "webhook.delete", "webhook",
                strconv.FormatInt(id, 10), "bulk")
        }

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "ok":       true,
            "affected": result.RowsAffected,
        })
    }
}
```

The child delete error is ignored — if no deliveries exist for some webhooks, that's expected. The parent delete error is not ignored because that's the operation the user asked for.

Use hard-delete for records that have no business value after deletion (webhook configs, notification entries). Use soft-delete for records that may need recovery or audit trails (users, admins).

---

## Bulk state change

Revoke, disable, or change status on multiple records at once. Same structure as soft-delete but with a different column:

```go
func bulkRevokeHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        var req struct {
            IDs []int64 `json:"ids"`
        }
        if err := http.ReadJSON(r, &req); err != nil {
            http.WriteError(w, http.StatusBadRequest, "invalid request body")
            return
        }
        if !http.CheckBulkIDs(w, req.IDs, 100) {
            return
        }

        now := sqlite.Now()
        ids := make([]any, len(req.IDs))
        for i, id := range req.IDs {
            ids[i] = id
        }

        query, args := sqlite.Update("api_keys").
            Set("revoked_at", now).
            WhereNull("revoked_at").
            WhereIn("id", ids...).
            Build()
        result, err := db.Exec(query, args...)
        if err != nil {
            http.WriteServerError(w, r, "failed to bulk revoke api keys", err)
            return
        }

        for _, id := range req.IDs {
            adminaudit.Log(db, r, "api_key.revoke", "api_key",
                strconv.FormatInt(id, 10), "bulk")
        }

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "ok":       true,
            "affected": result.RowsAffected,
        })
    }
}
```

The `WhereNull("revoked_at")` guard prevents re-revoking already-revoked keys — same idempotency pattern as the soft-delete null check. Register as:

```go
admin.HandleFunc("POST /api-keys/bulk-revoke", bulkRevokeHandler(db))
```

---

## Loop-based bulk operations

When each item needs a service method call instead of a direct SQL query, loop through the IDs and count successes:

```go
func bulkRetryHandler(q *queue.Queue, db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        var req struct {
            IDs []int64 `json:"ids"`
        }
        if err := http.ReadJSON(r, &req); err != nil {
            http.WriteError(w, http.StatusBadRequest, "invalid request body")
            return
        }
        if !http.CheckBulkIDs(w, req.IDs, 100) {
            return
        }

        var affected int64
        for _, id := range req.IDs {
            if err := q.Retry(id); err == nil {
                affected++
                adminaudit.Log(db, r, "job.retry", "job",
                    strconv.FormatInt(id, 10), "bulk")
            }
        }

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "ok":       true,
            "affected": affected,
        })
    }
}
```

Key differences from set-based operations:

- No `WhereIn` — each ID goes through the service method individually
- Only successful operations are counted and audited
- Partial success is expected — some IDs may already be in a state where the operation doesn't apply (e.g., retrying a job that already succeeded)
- The handler never returns an error for individual failures — it returns how many succeeded

Use this pattern when the operation involves business logic beyond a simple SQL update (queue retry resets state and re-enqueues, cancel terminates a running job's context).

---

## Batch upsert

For key-value data where the input is a map instead of an ID list, use the batch upsert pattern:

```go
func batchUpsertHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        claims, ok := auth.ClaimsFromContext(r.Context())
        if !ok {
            http.WriteError(w, http.StatusUnauthorized, "authentication required")
            return
        }

        var req struct {
            Settings map[string]string `json:"settings"`
        }
        if err := http.ReadJSON(r, &req); err != nil {
            http.WriteError(w, http.StatusBadRequest, "invalid request body")
            return
        }

        v := validate.Fields(
            validate.Check("settings", len(req.Settings) > 0,
                "at least one setting is required"),
            validate.Check("settings", len(req.Settings) <= 50,
                "maximum 50 settings per request"),
        )
        if v.HasErrors() {
            v.WriteError(w)
            return
        }

        now := sqlite.Now()

        for key, value := range req.Settings {
            sql, args := sqlite.Insert("user_settings").
                Set("user_id", claims.UID).
                Set("key", key).
                Set("value", value).
                Set("created_at", now).
                Set("updated_at", now).
                OnConflict(
                    []string{"user_id", "key"},
                    []string{"value", "updated_at"},
                ).
                Build()
            if _, err := db.Exec(sql, args...); err != nil {
                http.WriteServerError(w, r, "failed to save setting", err)
                return
            }
        }

        http.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
    }
}
```

`OnConflict` generates `INSERT ... ON CONFLICT(user_id, key) DO UPDATE SET value = ?, updated_at = ?`. The first argument is the conflict columns (the unique constraint), the second is the columns to update on conflict.

Unlike ID-based bulk operations, batch upserts:

- Use `validate.Fields` instead of `CheckBulkIDs` because the input is a map, not an ID list
- Validate both emptiness and maximum count, plus individual key constraints
- Return the full updated state rather than an `affected` count (the client needs to see the merged result)

---

## Webhook dispatch

Fire a webhook event after bulk operations so external systems can react:

```go
// After the operation and audit logging:

_ = wh.Dispatch(r.Context(), "user.bulk_deleted", map[string]any{
    "ids":      req.IDs,
    "affected": result.RowsAffected,
})
```

Dispatch errors are ignored with `_` — webhook delivery is best-effort and should never block the response. The payload includes both the requested IDs and the actual affected count so the receiver knows what changed.

Not every bulk operation needs a webhook. Use webhooks for entity lifecycle events (user deleted, API key revoked) where external systems may need to update their state. Skip webhooks for internal operations (queue retry, notification cleanup).

---

## Routing conventions

All bulk operations follow the same naming pattern:

```go
admin.HandleFunc("POST /users/bulk-delete", bulkDeleteHandler(db))
admin.HandleFunc("POST /api-keys/bulk-revoke", bulkRevokeHandler(db))
admin.HandleFunc("POST /queue/jobs/bulk-retry", bulkRetryHandler(q, db))
admin.HandleFunc("POST /queue/jobs/bulk-cancel", bulkCancelHandler(q, db))
admin.HandleFunc("POST /webhooks/bulk-delete", bulkDeleteHandler(db))
admin.HandleFunc("POST /sessions/bulk-revoke", bulkRevokeHandler(db, wh))
admin.HandleFunc("POST /uploads/bulk-delete", bulkDeleteHandler(db))
admin.HandleFunc("POST /notifications/bulk-delete", bulkDeleteHandler(db))
```

The conventions:

- Always **POST** — bulk operations carry a JSON body with IDs
- Route pattern: `/{resource}/bulk-{action}`
- Action names match the operation: `delete`, `revoke`, `retry`, `cancel`

---

## Rules

| # | Rule |
|---|------|
| 1 | **Cap at 100 IDs.** Use `http.CheckBulkIDs(w, req.IDs, 100)` as the first check after parsing the body. |
| 2 | **POST, not DELETE.** Bulk operations carry a JSON body — use POST for all of them. |
| 3 | **Guard against double-apply.** Add `WhereNull("deleted_at")` or `WhereNull("revoked_at")` so the operation is idempotent. |
| 4 | **Audit each ID individually.** Loop through `req.IDs` and call `adminaudit.Log` per record. The audit trail needs to show which specific records were affected. |
| 5 | **Return `affected` count.** Always return `{"ok": true, "affected": N}` so the client knows how many rows actually changed. |
| 6 | **Ignore side-effect errors.** Session revocation, child record cleanup, and webhook dispatch use `_, _` — they should never block the response. |
| 7 | **Soft-delete for recoverable entities.** Users, admins, uploads. Hard-delete for disposable records — webhooks, notifications. |
| 8 | **Convert `[]int64` to `[]any` for `WhereIn`.** The query builder requires `[]any` — build the conversion slice before the query. |
