---
title: Notifications
nextjs:
  metadata:
    title: Notifications
    description: How to send in-app and email notifications to admins and users.
---

The standalone app includes a full notification system — in-app notifications with optional email delivery. Notifications target either admins or end users via a polymorphic entity model. This recipe shows how to send notifications from your modules.

---

## Sending a notification

The simplest way to notify someone is with the standalone functions:

```go
import "github.com/stanza-go/standalone/module/notifications"

// Notify a specific admin
notifications.NotifyAdmin(db, adminID, "info", "New user registered", "John Doe signed up")

// Notify a specific user
notifications.NotifyUser(db, userID, "success", "Order shipped", "Your order #1234 has shipped")

// Notify all active admins
notifications.NotifyAllAdmins(db, "warning", "Disk space low", "Only 2GB remaining")
```

### Notification types

| Type | Use case |
|------|----------|
| `info` | General information |
| `success` | Action completed successfully |
| `warning` | Something needs attention |
| `error` | Something went wrong |

---

## Notifications with email

Use the `Service` type when you want optional email delivery alongside the in-app notification:

```go
svc := notifications.NewService(db, emailClient, logger)

// In-app only (default)
svc.NotifyAdmin(adminID, "info", "Report generated", "Monthly report is ready")

// In-app + email
svc.NotifyAdmin(adminID, "error", "Payment failed",
    "Order #1234 payment declined",
    notifications.WithEmail(ctx),
)
```

Email delivery is **best-effort** — failures are logged but never prevent the in-app notification from being created. The recipient's email address is automatically looked up from the admin or user table.

---

## Migration

The `notifications` table uses polymorphic entity targeting:

```go
func (m *CreateNotifications) Up(db *sqlite.DB) error {
    _, err := db.Exec(`CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL DEFAULT '',
        read_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    return err
}
```

| Column | Purpose |
|--------|---------|
| `entity_type` | `"admin"` or `"user"` |
| `entity_id` | The admin or user ID |
| `type` | Notification type (info, success, warning, error) |
| `read_at` | NULL = unread, timestamp = read |

---

## API endpoints

### Admin notifications

```
GET    /api/admin/notifications             — list (paginated, ?unread=true filter)
GET    /api/admin/notifications/unread-count — unread count
POST   /api/admin/notifications/send        — create notification with optional email
POST   /api/admin/notifications/{id}/read   — mark as read
POST   /api/admin/notifications/read-all    — mark all as read
DELETE /api/admin/notifications/{id}        — delete
```

### User notifications

```
GET    /api/user/notifications              — list (paginated, ?unread=true filter)
GET    /api/user/notifications/unread-count  — unread count
POST   /api/user/notifications/{id}/read    — mark as read
POST   /api/user/notifications/read-all     — mark all as read
DELETE /api/user/notifications/{id}         — delete
```

---

## Using notifications in your modules

Add a notification after a significant action:

```go
func createOrderHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        // ... create the order ...

        // Notify the user
        notifications.NotifyUser(db, order.UserID, "success",
            "Order placed",
            fmt.Sprintf("Order #%d has been placed successfully", order.ID),
        )

        // Notify admins
        notifications.NotifyAllAdmins(db, "info",
            "New order",
            fmt.Sprintf("Order #%d from %s ($%.2f)", order.ID, user.Name, order.Total),
        )

        http.WriteJSON(w, http.StatusCreated, map[string]any{"order": order})
    }
}
```

---

## Admin panel UI

The admin panel includes:

- **Notification bell** in the header — shows unread count badge and a dropdown with the latest 10 notifications
- **Notifications page** at `/admin/notifications` — full paginated list with unread filter, type badges, and bulk mark-read

The bell polls the unread count every 30 seconds (visibility-aware — pauses when the tab is in the background).

---

## Automatic cleanup

The built-in `purge-old-notifications` cron job runs daily at 5:00 AM and deletes **read** notifications older than 30 days. Unread notifications are kept indefinitely.

---

## Tips

- **Fire-and-forget.** Notification creation never blocks the primary operation. If the insert fails, it's logged silently.
- **Hard delete.** User-initiated deletion removes the row entirely (not soft delete). The purge cron only removes old read notifications.
- **Extend with data.** The `data` column (JSON text) is available for structured metadata — link URLs, entity references, etc. Use the `Notify` function directly to pass custom data.
- **Email opt-in per call.** There's no global or per-user email preference — the caller decides with `WithEmail(ctx)`. This keeps the system simple and avoids a preferences table.
