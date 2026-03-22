---
title: Audit logging
nextjs:
  metadata:
    title: Audit logging
    description: How to track admin actions with automatic audit logging.
---

Every admin action in a Stanza app is recorded in an audit log — who did what, when, and from where. This recipe shows how to add audit logging to your modules.

---

## How it works

The `adminaudit` module provides a fire-and-forget `Log` function. It extracts the admin's identity from the JWT in the request context and records the action in the `audit_log` table.

```go
import "github.com/stanza-go/standalone/module/adminaudit"

adminaudit.Log(db, r, "product.create", "product", "42", "Widget Pro")
```

| Parameter | Purpose |
|-----------|---------|
| `db` | Database connection |
| `r` | HTTP request (used to extract admin ID and IP) |
| `action` | What happened — `entity.verb` format |
| `entity_type` | What kind of thing was affected |
| `entity_id` | ID of the affected entity |
| `details` | Free-text detail (email, name, description of change) |

---

## Action naming convention

Actions follow the `entity.verb` pattern:

| Action | When |
|--------|------|
| `product.create` | Created a new product |
| `product.update` | Updated a product |
| `product.delete` | Soft-deleted a product |
| `user.create` | Created a new user |
| `user.impersonate` | Generated impersonation token |
| `session.revoke` | Revoked a refresh token |
| `setting.update` | Changed an application setting |
| `cron.trigger` | Manually triggered a cron job |
| `job.retry` | Retried a failed queue job |
| `database.download` | Downloaded the SQLite file |

---

## Adding audit logging to a module

Call `adminaudit.Log` after every successful mutation:

```go
func createHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        // ... validate, insert into database ...

        adminaudit.Log(db, r, "product.create", "product",
            strconv.FormatInt(result.LastInsertID, 10), req.Name)

        http.WriteJSON(w, http.StatusCreated, map[string]any{"product": p})
    }
}

func deleteHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        // ... soft-delete from database ...

        adminaudit.Log(db, r, "product.delete", "product",
            strconv.FormatInt(id, 10), "")

        http.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
    }
}
```

---

## What gets recorded

Each audit entry captures:

| Column | Source |
|--------|--------|
| `admin_id` | Extracted from JWT claims in request context |
| `action` | The `entity.verb` string you pass |
| `entity_type` | What was affected |
| `entity_id` | ID of the affected entity |
| `details` | Free-text context |
| `ip_address` | From `X-Forwarded-For` header or `RemoteAddr` |
| `created_at` | UTC timestamp |

---

## Viewing the audit log

The admin panel shows the audit log at `/admin/audit` with:

- Paginated, filterable list of all admin actions
- Filter by action type and admin user
- Search in details
- Timestamps and IP addresses

The dashboard at `/admin` also shows the 10 most recent actions as an activity feed.

API endpoints:

```
GET /api/admin/audit         — paginated list with filters
GET /api/admin/audit/recent  — last 10 entries (dashboard feed)
```

---

## Automatic cleanup

The built-in `purge-old-audit-log` cron job runs daily at 4:00 AM and deletes entries older than 90 days. Adjust the retention period in `provideCron` if needed.

---

## Tips

- **Fire-and-forget.** `adminaudit.Log` silently ignores errors — audit logging never blocks the primary operation.
- **Log after success.** Call `Log` after the database write succeeds, not before.
- **Use details wisely.** Include the most useful context — an email address, a name, or a description of what changed. Keep it short.
- **Admin-only.** The audit log tracks admin actions. User-facing actions (login, profile update) have their own patterns — user auth events are tracked via refresh tokens and access logs.
