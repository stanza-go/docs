---
title: Webhooks
nextjs:
  metadata:
    title: Webhooks
    description: Outgoing webhook delivery with HMAC-SHA256 signatures and configurable retry logic.
---

The `pkg/webhook` package provides an HTTP client for delivering outgoing webhook events with HMAC-SHA256 signatures and exponential backoff retry. The signature scheme follows industry conventions (Stripe, Svix). It is built entirely on Go's standard library — no external dependencies.

```go
import "github.com/stanza-go/framework/pkg/webhook"
```

---

## Creating a client

Create a client with functional options:

```go
client := webhook.NewClient()
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `WithTimeout(d)` | `10s` | Per-request HTTP timeout |
| `WithMaxRetries(n)` | `3` | Maximum retry attempts for `SendWithRetry` (up to `n+1` total attempts) |
| `WithRetryBaseDelay(d)` | `1s` | Base delay for exponential backoff; each retry doubles the delay |
| `WithRetryMaxDelay(d)` | `30s` | Maximum delay between retries |

```go
client := webhook.NewClient(
    webhook.WithTimeout(5 * time.Second),
    webhook.WithMaxRetries(5),
    webhook.WithRetryBaseDelay(2 * time.Second),
    webhook.WithRetryMaxDelay(60 * time.Second),
)
```

---

## Sending a webhook

Use `Send` for a single delivery attempt:

```go
result, err := client.Send(ctx, &webhook.Delivery{
    URL:     "https://example.com/webhook",
    Secret:  "whsec_abc123",
    Event:   "user.created",
    Payload: jsonBytes,
})
if err != nil {
    // network error or request creation failure
}
// result.StatusCode, result.Body, result.DeliveryID
```

`Send` makes one attempt. A non-2xx response is **not** an error — inspect `Result.StatusCode` to determine success.

---

## Sending with retry

Use `SendWithRetry` for automatic retry with exponential backoff:

```go
result, err := client.SendWithRetry(ctx, &webhook.Delivery{
    URL:     "https://example.com/webhook",
    Secret:  "whsec_abc123",
    Event:   "order.completed",
    Payload: jsonBytes,
})
```

### Retry behavior

| Response | Action |
|----------|--------|
| 2xx | Success — return immediately |
| 4xx | Client error — return immediately, no retry |
| 5xx | Server error — retry with backoff |
| Network error | Retry with backoff |

Backoff doubles with each attempt: 1s, 2s, 4s, 8s, ... capped at `retryMaxDelay`. The context is checked between retries — cancellation stops the loop.

---

## Delivery struct

```go
type Delivery struct {
    URL     string            // Endpoint URL (required)
    Secret  string            // HMAC-SHA256 signing key (optional)
    Event   string            // Event type, sent as X-Webhook-Event header
    Payload []byte            // Raw JSON body
    Headers map[string]string // Additional headers (added after standard webhook headers)
}
```

If `Secret` is empty, no signature headers are added. Custom `Headers` can override the standard webhook headers if needed.

---

## Result struct

```go
type Result struct {
    StatusCode int    // HTTP status code from the endpoint
    Body       string // Response body (truncated to 64KB)
    Attempts   int    // Total attempts made
    DeliveryID string // Unique delivery ID (format: whd_<hex>)
}
```

---

## Signature headers

Every delivery includes these headers:

| Header | Value | Example |
|--------|-------|---------|
| `X-Webhook-ID` | Unique delivery ID | `whd_a1b2c3d4e5f6...` |
| `X-Webhook-Timestamp` | Unix timestamp | `1742428800` |
| `X-Webhook-Event` | Event type | `user.created` |
| `X-Webhook-Signature` | HMAC-SHA256 hex digest | `e3b0c44298fc1c14...` |

The signature is computed over `{id}.{timestamp}.{body}` using the delivery's secret as the HMAC key. This matches the Stripe/Svix convention and allows recipients to verify authenticity.

---

## Signing and verifying

The package exports `Sign` and `Verify` for manual signature operations:

```go
// Compute a signature
sig := webhook.Sign(secret, deliveryID, timestamp, body)

// Verify a received signature
valid := webhook.Verify(secret, deliveryID, timestamp, signature, body)
```

`Verify` uses constant-time comparison (`hmac.Equal`) to prevent timing attacks.

### Verifying in a handler

When receiving webhooks from an external system that uses this signature scheme:

```go
func webhookHandler(w http.ResponseWriter, r *http.Request) {
    body, _ := io.ReadAll(r.Body)

    id := r.Header.Get("X-Webhook-ID")
    ts := r.Header.Get("X-Webhook-Timestamp")
    sig := r.Header.Get("X-Webhook-Signature")

    if !webhook.Verify("whsec_your_secret", id, ts, sig, body) {
        http.Error(w, "invalid signature", http.StatusUnauthorized)
        return
    }

    // Signature valid — process the event
}
```

---

## Error handling

```go
// URL is required
var err error
_, err = client.Send(ctx, &webhook.Delivery{})
// err == webhook.ErrNoURL
```

Network errors and request creation failures are returned as wrapped errors. Non-2xx responses are **not** errors — they're returned in `Result.StatusCode` so the caller can decide how to handle them.

---

## Client stats

The client tracks cumulative delivery counters using atomic operations. Call `Stats()` for a thread-safe snapshot:

```go
stats := client.Stats()
fmt.Println(stats.Sends, stats.Successes, stats.Failures)
```

| Field | Type | Description |
|-------|------|-------------|
| `Sends` | `int64` | Total `Send` or `SendWithRetry` calls |
| `Successes` | `int64` | Deliveries that received a 2xx response |
| `Failures` | `int64` | Deliveries that received a non-2xx response |
| `Retries` | `int64` | Retry attempts (only from `SendWithRetry`) |
| `Errors` | `int64` | Network or request-building errors |

All counters are cumulative since the client was created. `Stats()` is safe to call concurrently from any goroutine.

---

## API reference

| Function/Method | Signature | Description |
|-----------------|-----------|-------------|
| `NewClient` | `(opts ...Option) *Client` | Create a client with options |
| `Send` | `(ctx, *Delivery) (*Result, error)` | Single delivery attempt |
| `SendWithRetry` | `(ctx, *Delivery) (*Result, error)` | Delivery with exponential backoff retry |
| `Stats` | `() ClientStats` | Snapshot of cumulative delivery counters |
| `Sign` | `(secret, id, timestamp string, body []byte) string` | Compute HMAC-SHA256 signature |
| `Verify` | `(secret, id, timestamp, signature string, body []byte) bool` | Verify a signature (constant-time) |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `HeaderID` | `X-Webhook-ID` | Delivery ID header |
| `HeaderTimestamp` | `X-Webhook-Timestamp` | Unix timestamp header |
| `HeaderSignature` | `X-Webhook-Signature` | HMAC-SHA256 signature header |
| `HeaderEvent` | `X-Webhook-Event` | Event type header |

---

## Tips

- **Always set a secret.** Without a secret, recipients cannot verify that the delivery came from your application. Generate secrets with a prefix like `whsec_` for easy identification.
- **Use SendWithRetry for async delivery.** In the standalone app, webhooks are delivered via the job queue — the queue handles retries. Use `Send` (single attempt) inside a queue handler and let the queue manage retry logic.
- **Check the status code.** A `200` response means the recipient acknowledged the webhook. A `4xx` means the recipient rejected it (bad payload, invalid event) and retrying won't help. A `5xx` means the recipient's server had an issue and a retry may succeed.
- **Keep payloads small.** The response body is truncated to 64KB. Keep your webhook payloads focused on the event data — don't send large blobs.

See the [Webhooks](/recipes/webhooks) recipe for integration patterns with the standalone app's webhook management system.
