---
title: User settings
nextjs:
  metadata:
    title: User settings
    description: How to store per-user preferences and settings as key-value pairs.
---

The standalone app includes a per-user settings module for storing user preferences as key-value pairs. Each user has their own isolated set of settings — useful for theme preferences, notification toggles, language choice, or any client-defined configuration. This recipe shows how the module works and how to use it from your frontend.

---

## How it works

User settings are stored in a `user_settings` table with a `UNIQUE(user_id, key)` constraint. Each setting is a simple key-value pair scoped to the authenticated user. There are no predefined keys — the frontend defines what keys to use and how to interpret the values.

This is different from the admin `settings` table, which stores app-wide configuration grouped by category. User settings are personal and per-user.

---

## API endpoints

```
GET    /api/user/settings       — list all settings for the authenticated user
GET    /api/user/settings/{key} — get a specific setting by key
PUT    /api/user/settings       — batch upsert settings
DELETE /api/user/settings/{key} — delete a specific setting
```

All endpoints require authentication with the `"user"` scope.

---

## Saving settings

Use the batch upsert endpoint to save one or more settings at once:

```bash
curl -X PUT http://localhost:23710/api/user/settings \
  -H "Content-Type: application/json" \
  -b "access_token=..." \
  -d '{
    "settings": {
      "theme": "dark",
      "language": "en",
      "notifications.email": "true",
      "dashboard.collapsed": "false"
    }
  }'
```

Response (returns all user settings after upsert):

```json
{
  "settings": [
    { "key": "dashboard.collapsed", "value": "false", "updated_at": "2026-03-22T10:00:00Z" },
    { "key": "language", "value": "en", "updated_at": "2026-03-22T10:00:00Z" },
    { "key": "notifications.email", "value": "true", "updated_at": "2026-03-22T10:00:00Z" },
    { "key": "theme", "value": "dark", "updated_at": "2026-03-22T10:00:00Z" }
  ]
}
```

The upsert uses SQLite's `ON CONFLICT DO UPDATE` — existing keys are updated, new keys are created.

---

## Reading settings

List all settings:

```bash
curl http://localhost:23710/api/user/settings \
  -b "access_token=..."
```

Get a single setting:

```bash
curl http://localhost:23710/api/user/settings/theme \
  -b "access_token=..."
```

Response:

```json
{
  "key": "theme",
  "value": "dark",
  "updated_at": "2026-03-22T10:00:00Z"
}
```

---

## Deleting a setting

```bash
curl -X DELETE http://localhost:23710/api/user/settings/theme \
  -b "access_token=..."
```

Returns 404 if the key doesn't exist for the authenticated user.

---

## Migration

```go
func createUserSettingsUp(tx *sqlite.Tx) error {
    _, err := tx.Exec(`CREATE TABLE user_settings (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        key        TEXT    NOT NULL,
        value      TEXT    NOT NULL DEFAULT '',
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(user_id, key)
    )`)
    if err != nil {
        return err
    }

    _, err = tx.Exec(`CREATE INDEX idx_user_settings_user_id ON user_settings(user_id)`)
    return err
}
```

The `UNIQUE(user_id, key)` constraint ensures each user can have at most one value per key and enables the `ON CONFLICT DO UPDATE` upsert pattern.

---

## Wiring

The module is registered on the user route group in `main.go`:

```go
import "github.com/stanza-go/standalone/module/usersettings"

usersettings.Register(user, db)
```

The module takes only `db` as a dependency — no logger or other services needed.

---

## Frontend usage

A typical pattern for loading and saving user preferences from a React frontend:

```typescript
// Load settings on login
const res = await fetch('/api/user/settings', { credentials: 'include' });
const { settings } = await res.json();

// Convert array to a lookup map
const prefs = Object.fromEntries(settings.map(s => [s.key, s.value]));
// prefs.theme === "dark", prefs.language === "en", etc.

// Save when a preference changes
await fetch('/api/user/settings', {
  method: 'PUT',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    settings: { theme: 'light' }
  })
});
```

---

## Tips

- **Values are strings.** Store booleans as `"true"`/`"false"`, numbers as their string representation. The frontend interprets the type.
- **Key conventions.** Use dot notation for namespacing (e.g., `notifications.email`, `dashboard.layout`). There's no server-side enforcement — this is a frontend concern.
- **Batch upsert is the primary write method.** There's no single-key PUT endpoint. Send one or more keys in a single request. The response always returns the complete settings list so the client stays in sync.
- **Validation limits.** Keys must be 1-255 characters. Maximum 50 settings per batch request.
- **No grouping column.** Unlike the admin `settings` table which has a `group_name` column, user settings have no server-side grouping. Group settings in your frontend however you like.
- **Per-user isolation.** Users can only read and write their own settings. There's no cross-user access.
