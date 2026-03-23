---
title: Webhooks
nextjs:
  metadata:
    title: Webhooks
    description: How to add outgoing webhook support to your Stanza application.
---

The standalone app includes a full webhook management system — admins can register webhook endpoints, subscribe to events, and receive HTTP callbacks with HMAC-SHA256 signatures when events occur. This recipe shows how to emit webhook events from your modules and how recipients verify signatures.

---

## How it works

1. An admin creates a webhook via the admin panel or API, specifying a URL and which events to subscribe to
2. Your module code calls `dispatcher.Dispatch(ctx, "event.name", payload)` when something happens
3. The dispatcher finds all active webhooks subscribed to that event
4. A delivery record is created in the `webhook_deliveries` table
5. A job is enqueued for async delivery via the queue
6. The queue worker delivers the webhook with HMAC-SHA256 signature headers
7. Failed deliveries are retried automatically (up to 4 total attempts)

---

## Dispatching events

Inject the `Dispatcher` into your module and call `Dispatch` when events occur:

```go
package orders

import (
    "github.com/stanza-go/framework/pkg/http"
    "github.com/stanza-go/framework/pkg/sqlite"
    "github.com/stanza-go/standalone/module/webhooks"
)

func Register(api *http.Group, db *sqlite.DB, dispatcher *webhooks.Dispatcher) {
    api.HandleFunc("POST /orders", createHandler(db, dispatcher))
}

func createHandler(db *sqlite.DB, dispatcher *webhooks.Dispatcher) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        // ... create the order ...

        // Dispatch webhook event (async — returns immediately)
        _ = dispatcher.Dispatch(r.Context(), "order.created", map[string]any{
            "id":     order.ID,
            "total":  order.Total,
            "status": "pending",
        })

        http.WriteJSON(w, http.StatusCreated, map[string]any{"order": order})
    }
}
```

`Dispatch` is fire-and-forget — it enqueues jobs for matching webhooks and returns. The actual HTTP delivery happens asynchronously in the queue worker.

---

## Event naming convention

Use `entity.verb` format for event names:

| Event | Description |
|-------|-------------|
| `user.created` | A new user registered |
| `user.updated` | User profile was updated |
| `user.deleted` | User was deleted |
| `order.created` | A new order was placed |
| `order.completed` | An order was fulfilled |
| `webhook.test` | Test event sent from admin panel |

Admins can subscribe to specific events or use wildcards:

| Pattern | Matches |
|---------|---------|
| `*` | All events |
| `user.*` | All user events (`user.created`, `user.updated`, etc.) |
| `order.created` | Only `order.created` |

---

## Wiring the dispatcher

The dispatcher is created via a provider function and injected through lifecycle DI:

```go
func provideWebhookDispatcher(db *sqlite.DB, q *queue.Queue, logger *log.Logger) *webhooks.Dispatcher {
    return webhooks.NewDispatcher(db, q, logger)
}
```

It registers a `webhook.deliver` queue handler automatically. When a job is picked up, the worker delivers the webhook via `pkg/webhook.Client.Send` and updates the delivery record with the result.

---

## Migration

The webhook system uses two tables:

```go
func createWebhooksUp(tx *sqlite.Tx) error {
    _, err := tx.Exec(`CREATE TABLE webhooks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        url         TEXT    NOT NULL,
        secret      TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        events      TEXT    NOT NULL DEFAULT '["*"]',
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_by  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
    )`)
    if err != nil {
        return err
    }

    _, err = tx.Exec(`CREATE TABLE webhook_deliveries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id    INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        delivery_id   TEXT    NOT NULL DEFAULT '',
        event         TEXT    NOT NULL,
        payload       TEXT    NOT NULL DEFAULT '{}',
        status        TEXT    NOT NULL DEFAULT 'pending',
        status_code   INTEGER NOT NULL DEFAULT 0,
        response_body TEXT    NOT NULL DEFAULT '',
        attempts      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL,
        completed_at  TEXT
    )`)
    return err
}
```

| Table | Purpose |
|-------|---------|
| `webhooks` | Registered webhook endpoints with URL, secret, and event subscriptions |
| `webhook_deliveries` | Delivery history with status, response, and attempt count |

---

## Admin API endpoints

```
GET    /api/admin/webhooks              — list all webhooks (paginated, searchable)
POST   /api/admin/webhooks              — create a new webhook
GET    /api/admin/webhooks/{id}         — webhook detail with delivery stats
PUT    /api/admin/webhooks/{id}         — update URL, events, or active status
DELETE /api/admin/webhooks/{id}         — delete webhook and all deliveries
GET    /api/admin/webhooks/{id}/deliveries — delivery history (filterable by status)
POST   /api/admin/webhooks/{id}/test    — send a test event
```

All endpoints require the `admin:webhooks` scope.

Webhook URLs are validated with `validate.PublicURL` to prevent SSRF — URLs pointing to localhost, private networks (10.x, 172.16-31.x, 192.168.x), or other reserved addresses are rejected.

### Creating a webhook

```bash
curl -X POST http://localhost:23710/api/admin/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/webhook",
    "description": "Order notifications",
    "events": ["order.created", "order.completed"]
  }'
```

The response includes the auto-generated secret (`whsec_...`). Secrets are shown once at creation — store them securely.

### Sending a test event

```bash
curl -X POST http://localhost:23710/api/admin/webhooks/1/test
```

This dispatches a `webhook.test` event through the normal delivery pipeline so the recipient can verify their endpoint works.

---

## Admin panel

The admin panel includes two webhook pages:

- **Webhooks list** (`/admin/webhooks`) — table of all webhooks with URL, event count, active status, and actions
- **Webhook detail** (`/admin/webhooks/:id`) — webhook info, delivery stats (total/success/failed), and delivery history table with status badges

---

## Signature verification (for recipients)

Recipients verify webhook authenticity by recomputing the HMAC-SHA256 signature. Every delivery includes four headers:

| Header | Purpose |
|--------|---------|
| `X-Webhook-ID` | Unique delivery ID |
| `X-Webhook-Timestamp` | Unix timestamp when the delivery was created |
| `X-Webhook-Signature` | HMAC-SHA256 hex digest |
| `X-Webhook-Event` | Event type (e.g. `order.created`) |

The signature is computed over `{id}.{timestamp}.{body}` using the webhook secret as the HMAC key:

### Go

```go
import "github.com/stanza-go/framework/pkg/webhook"

valid := webhook.Verify(secret,
    r.Header.Get("X-Webhook-ID"),
    r.Header.Get("X-Webhook-Timestamp"),
    r.Header.Get("X-Webhook-Signature"),
    body,
)
```

### Node.js

```javascript
const crypto = require('crypto');

function verify(secret, id, timestamp, signature, body) {
    const content = `${id}.${timestamp}.${body}`;
    const expected = crypto
        .createHmac('sha256', secret)
        .update(content)
        .digest('hex');
    return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature),
    );
}
```

### Python

```python
import hmac
import hashlib

def verify(secret, id, timestamp, signature, body):
    content = f"{id}.{timestamp}.{body}".encode()
    expected = hmac.new(secret.encode(), content, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

---

## Tips

- **Secrets are auto-generated.** The `GenerateSecret()` function creates `whsec_`-prefixed secrets with 24 random bytes. Don't let users set their own secrets.
- **Events are stored as JSON arrays.** The `events` column in the `webhooks` table is a JSON string like `["user.*", "order.created"]`. The wildcard `*` matches all events.
- **Delivery is async.** `Dispatch` never blocks the request — it enqueues jobs and returns. This means the response to the client is not delayed by webhook delivery.
- **Failed deliveries are retried.** The queue retries failed jobs up to 4 total attempts with exponential backoff. After exhausting retries, the delivery is marked as `failed`.
- **Response body is truncated.** The `response_body` in `webhook_deliveries` stores up to 4KB of the recipient's response for debugging.
- **Delivery retention.** The built-in `purge-old-webhook-deliveries` cron job removes delivery records older than 30 days to keep the table lean.
- **Test before going live.** Use the admin panel's "Send test" button or `POST /api/admin/webhooks/{id}/test` to verify the endpoint works before subscribing to real events.
