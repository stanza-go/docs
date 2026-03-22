---
title: User activity log
nextjs:
  metadata:
    title: User activity log
    description: How to expose account activity history to end users.
---

The standalone app includes a user-facing activity log that gives users visibility into actions performed on their account. Users can see what happened (profile updates, password resets, session revocations) without seeing who did it. This recipe explains the module and how to use it.

---

## How it works

The user activity endpoint queries the same `audit_log` table used by the admin audit log, filtered to entries where `entity_type='user'` and `entity_id` matches the authenticated user's ID. This means any admin action that targets a user — creating their account, updating their profile, resetting their password, impersonating them — automatically appears in the user's activity feed.

A key design decision: **admin identity is intentionally omitted** from the response. Users see the action, details, IP address, and timestamp, but not which admin performed it. This prevents social engineering risks from exposing admin identities to end users.

---

## API endpoint

```
GET /api/user/activity — list audit log entries targeting the authenticated user
```

Requires authentication with the `"user"` scope.

### Query parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `limit` | 20 | Number of entries to return (max 100) |
| `offset` | 0 | Pagination offset |
| `action` | — | Filter by action type (e.g., `user.update`) |
| `from` | — | Filter entries from this date (ISO 8601) |
| `to` | — | Filter entries until this date (ISO 8601) |

---

## Example request

```bash
curl "http://localhost:23710/api/user/activity?limit=10&action=user.update" \
  -b "access_token=..."
```

Response:

```json
{
  "entries": [
    {
      "id": 42,
      "action": "user.update",
      "details": "Updated profile: name, email",
      "ip_address": "192.168.1.1",
      "created_at": "2026-03-22T10:30:00Z"
    },
    {
      "id": 38,
      "action": "user.update",
      "details": "Password changed",
      "ip_address": "192.168.1.1",
      "created_at": "2026-03-21T15:00:00Z"
    }
  ],
  "total": 2
}
```

---

## Action types

These are the audit log actions that target users:

| Action | When it appears |
|--------|----------------|
| `user.create` | Account was created |
| `user.update` | Profile was updated (name, email, etc.) |
| `user.delete` | Account was deactivated |
| `user.impersonate` | An admin generated an impersonation token |

The action names follow the `entity.verb` convention used throughout the audit logging system.

---

## Date range filtering

Filter activity to a specific time window:

```bash
# Activity in the last 7 days
curl "http://localhost:23710/api/user/activity?from=2026-03-15T00:00:00Z&to=2026-03-22T23:59:59Z" \
  -b "access_token=..."
```

Both `from` and `to` are optional and can be used independently.

---

## Wiring

The module is registered on the user route group in `main.go`:

```go
import "github.com/stanza-go/standalone/module/useractivity"

useractivity.Register(user, db)
```

The module takes only `db` as a dependency. It's read-only — it doesn't write to the audit log. Audit entries are created by other modules (admin user management, password reset, etc.) as part of their normal operations.

---

## Tips

- **Read-only.** This module only reads the audit log — it has no write endpoints. Activity entries are created automatically by admin modules when they perform actions on users.
- **Privacy by design.** Admin identity (admin_id, admin_email, admin_name) is excluded from the response. Users see what happened to their account, not who did it.
- **No user self-actions.** This log shows admin actions *on* the user, not the user's own API activity. If you need to track user-initiated actions (login history, API calls), add separate logging in the relevant user modules.
- **Pagination.** Default limit is 20, maximum is 100. Use `offset` for pagination. The `total` field in the response tells you how many entries match the current filters.
- **Shared infrastructure.** The audit log table is shared between admin and user views. Adding audit logging in a new admin module (via the `auditlog.Log()` function with `entity_type="user"`) automatically makes those entries visible in the user's activity feed.
