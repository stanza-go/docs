---
title: Email
nextjs:
  metadata:
    title: Email
    description: Send transactional emails via the Resend API with zero external dependencies.
---

The `pkg/email` package provides a simple client for sending transactional emails via the [Resend](https://resend.com) HTTP API. It is built entirely on Go's standard library — no external dependencies.

```go
import "github.com/stanza-go/framework/pkg/email"
```

---

## Creating a client

Create a client with your Resend API key and a default sender address:

```go
client := email.New("re_your_api_key",
    email.WithFrom("noreply@example.com"),
)
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `WithFrom(addr)` | — | Default sender address for all messages |
| `WithEndpoint(url)` | `https://api.resend.com/emails` | Override the API endpoint (useful for testing) |
| `WithTimeout(d)` | `10s` | HTTP request timeout |

---

## Sending an email

```go
result, err := client.Send(ctx, email.Message{
    To:      []string{"user@example.com"},
    Subject: "Welcome to the app",
    HTML:    "<h1>Hello!</h1><p>Welcome aboard.</p>",
    Text:    "Hello! Welcome aboard.",
})
if err != nil {
    // handle error
}
// result.ID is the Resend message ID
```

### Message fields

| Field | Required | Description |
|-------|----------|-------------|
| `To` | Yes | List of recipient email addresses |
| `Subject` | Yes | Email subject line |
| `HTML` | One of HTML/Text | HTML body |
| `Text` | One of HTML/Text | Plain-text body |
| `From` | No | Overrides the client-level default sender |
| `ReplyTo` | No | Reply-To addresses |

---

## Checking configuration

Use `Configured()` to skip email-sending when no API key is set (e.g., local development):

```go
if client.Configured() {
    _, err := client.Send(ctx, msg)
    // ...
} else {
    logger.Warn("email not configured, skipping send")
}
```

---

## Error handling

`Send` returns typed errors for validation issues and API failures:

```go
// Validation errors (returned before making the API call)
email.ErrNoRecipient  // no To addresses
email.ErrNoSubject    // empty subject
email.ErrNoBody       // neither HTML nor Text provided
email.ErrNoFrom       // no sender (neither client default nor message-level)
email.ErrNoAPIKey     // empty API key

// API errors (non-2xx response from Resend)
var apiErr *email.APIError
if errors.As(err, &apiErr) {
    log.Printf("Resend API error (status %d): %s", apiErr.StatusCode, apiErr.Body)
}
```

---

## Wiring in a Stanza app

In the standalone app, the email client is created via a provider function and injected into modules that need it:

```go
func provideEmail(cfg *config.Config) *email.Client {
    apiKey := cfg.String("email.resend_api_key", "")
    from := cfg.String("email.from", "noreply@stanza.dev")

    return email.New(apiKey, email.WithFrom(from))
}
```

Configuration is set via environment variables:

| Env Var | Config Key | Description |
|---------|------------|-------------|
| `STANZA_EMAIL_RESEND_API_KEY` | `email.resend_api_key` | Resend API key |
| `STANZA_EMAIL_FROM` | `email.from` | Default sender address |

---

## Testing

Use `WithEndpoint` to point the client at an `httptest.Server` in tests:

```go
func TestSendEmail(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(200)
        w.Write([]byte(`{"id": "test-id"}`))
    }))
    defer srv.Close()

    client := email.New("test-key",
        email.WithFrom("test@example.com"),
        email.WithEndpoint(srv.URL),
    )

    result, err := client.Send(context.Background(), email.Message{
        To:      []string{"user@example.com"},
        Subject: "Test",
        HTML:    "<p>Hello</p>",
    })
    if err != nil {
        t.Fatal(err)
    }
    if result.ID != "test-id" {
        t.Errorf("got ID %q, want %q", result.ID, "test-id")
    }
}
```

---

## Client stats

The client tracks cumulative email delivery counters using atomic operations. Call `Stats()` for a thread-safe snapshot:

```go
stats := client.Stats()
fmt.Println(stats.Sent, stats.Errors)
```

| Field | Type | Description |
|-------|------|-------------|
| `Sent` | `int64` | Total emails successfully delivered to the API |
| `Errors` | `int64` | Total failed send attempts (transport errors, non-2xx responses, or decode failures) |

All counters are cumulative since the client was created. `Stats()` is safe to call concurrently from any goroutine.

---

## Tips

- **Always provide both HTML and Text.** Some email clients prefer plain text, and it improves deliverability.
- **Verify your domain.** Resend's `onboarding@resend.dev` sender works for testing but will have poor deliverability. Verify your domain at [resend.com/domains](https://resend.com/domains) for production.
- **Email is best-effort.** In features like notifications and password reset, the standalone app logs email failures but never blocks the primary operation.
