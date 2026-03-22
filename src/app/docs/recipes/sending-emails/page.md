---
title: Sending emails
nextjs:
  metadata:
    title: Sending emails
    description: How to send transactional emails in a Stanza app — client setup, HTML templates, error handling, and graceful degradation without an API key.
---

This recipe covers the patterns for sending transactional emails in a Stanza app using the `pkg/email` package. The [Email reference](/docs/email) documents the package API. This recipe shows how to wire it, write templates, handle errors, and degrade gracefully in development.

---

## Client setup

The email client is created in a provider function and injected via DI:

```go
func provideEmail(cfg *config.Config, logger *log.Logger) *email.Client {
    apiKey := cfg.GetString("email.resend_api_key")
    from := cfg.GetStringOr("email.from", "noreply@myapp.com")

    if apiKey == "" {
        logger.Info("email: no API key, email sending disabled")
    }

    return email.New(apiKey, email.WithFrom(from))
}
```

The client is always created, even without an API key. This keeps DI wiring simple — no conditional provides. Code that sends email checks `Configured()` before calling `Send()`.

Production environment variables:

```shell
STANZA_EMAIL_RESEND_API_KEY=re_live_...
STANZA_EMAIL_FROM="MyApp <noreply@myapp.com>"
```

---

## Sending a basic email

```go
result, err := emailClient.Send(ctx, email.Message{
    To:      []string{"user@example.com"},
    Subject: "Welcome to MyApp",
    HTML:    "<h1>Welcome!</h1><p>Your account is ready.</p>",
    Text:    "Welcome!\n\nYour account is ready.",
})
if err != nil {
    logger.Error("send welcome email", log.Err(err))
    return
}
// result.ID is the Resend message ID
```

Always include both `HTML` and `Text`. Many email clients (corporate, accessibility tools, CLI mail readers) prefer or require plain text. The Resend API accepts both and delivers the appropriate version.

---

## HTML email templates

Email HTML must use inline styles — most email clients strip `<style>` blocks and external CSS. Keep templates simple: a single-column layout with inline styles.

### Inline template function

The standalone uses `fmt.Sprintf` for simple templates:

```go
func welcomeEmailHTML(name string) string {
    return fmt.Sprintf(`<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  <h1 style="margin: 0 0 16px 0;">Welcome, %s!</h1>
  <p style="color: #444; line-height: 1.5;">Your account has been created. You can now log in and start using the app.</p>
  <p style="color: #999; font-size: 12px; margin-top: 32px;">This is an automated email from MyApp.</p>
</body>
</html>`, name)
}

func welcomeEmailText(name string) string {
    return fmt.Sprintf("Welcome, %s!\n\nYour account has been created. You can now log in and start using the app.", name)
}
```

For `fmt.Sprintf` templates, this approach works well because email content is controlled by the app, not by user input.

### html/template for user content

When the email body includes user-provided content (names, messages, custom text), use `html/template` to prevent HTML injection:

```go
import "html/template"

var orderConfirmationTmpl = template.Must(template.New("order").Parse(`<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="margin: 0 0 16px 0;">Order Confirmed</h2>
  <p>Hi {{.Name}}, your order <strong>#{{.OrderID}}</strong> has been confirmed.</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    {{range .Items}}
    <tr>
      <td style="padding: 8px; border-bottom: 1px solid #eee;">{{.Name}}</td>
      <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${{.Price}}</td>
    </tr>
    {{end}}
  </table>
  <p style="font-weight: bold;">Total: ${{.Total}}</p>
</body>
</html>`))

func renderOrderEmail(data OrderEmailData) (string, error) {
    var buf strings.Builder
    if err := orderConfirmationTmpl.Execute(&buf, data); err != nil {
        return "", fmt.Errorf("render order email: %w", err)
    }
    return buf.String(), nil
}
```

{% callout title="Template initialization" %}
Use `template.Must` at package level for templates with static structure. The `Must` call panics on parse errors at startup, which is the right behavior — a broken template should prevent boot, not cause silent failures at runtime.
{% /callout %}

---

## The Configured guard

In development, the email API key is usually not set. Guard every send with `Configured()`:

```go
if emailClient.Configured() {
    if err := sendResetEmail(ctx, emailClient, user.Email, token); err != nil {
        logger.Error("send reset email",
            log.String("email", user.Email),
            log.Err(err),
        )
    }
}
```

Without this guard, `Send()` returns `email.ErrNoAPIKey` — it won't panic or crash, but it would fill logs with errors during development.

For services that always receive the email client via DI, check both nil and configured:

```go
func (s *Service) sendNotification(ctx context.Context, userID int64, subject, html, text string) {
    if s.email == nil || !s.email.Configured() {
        return
    }

    addr, err := s.lookupEmail(userID)
    if err != nil {
        s.logger.Error("lookup email", log.Int64("user_id", userID), log.Err(err))
        return
    }

    _, err = s.email.Send(ctx, email.Message{
        To:      []string{addr},
        Subject: subject,
        HTML:    html,
        Text:    text,
    })
    if err != nil {
        s.logger.Error("send notification email", log.Int64("user_id", userID), log.Err(err))
    }
}
```

---

## Error handling patterns

Email delivery has two error handling strategies. Choose based on whether the email is the primary action or a side effect.

### Critical path — return the error

When the email IS the user's requested action (password reset, email verification), log and handle the error:

```go
func handleForgotPassword(emailClient *email.Client, logger *log.Logger) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // ... generate token ...

        if emailClient.Configured() {
            if err := sendResetEmail(r.Context(), emailClient, req.Email, token); err != nil {
                logger.Error("send reset email",
                    log.String("email", req.Email),
                    log.Err(err),
                )
                // Still return 200 — don't reveal whether the email exists.
                // But log the error so ops can investigate.
            }
        }

        http.WriteJSON(w, http.StatusOK, map[string]string{
            "message": "if that email exists, a reset link has been sent",
        })
    }
}
```

Note: even in the critical path, password reset returns 200 regardless of send success to prevent email enumeration.

### Side effect — log and move on

When the email is a notification alongside the primary action (user created, order placed, alert triggered), never let email failure block the response:

```go
func handleCreateUser(/* deps */) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // ... create user in DB ...

        // Welcome email is best-effort — don't fail the request
        if emailClient.Configured() {
            _, err := emailClient.Send(r.Context(), email.Message{
                To:      []string{user.Email},
                Subject: "Welcome to MyApp",
                HTML:    welcomeHTML(user.Name),
                Text:    welcomeText(user.Name),
            })
            if err != nil {
                logger.Error("send welcome email",
                    log.String("email", user.Email),
                    log.Err(err),
                )
            }
        }

        http.WriteJSON(w, http.StatusCreated, user)
    }
}
```

---

## Sending from background jobs

For non-urgent emails or bulk sends, queue them as jobs so they don't block the HTTP response:

```go
// In the handler — enqueue the job
payload, _ := json.Marshal(map[string]string{
    "user_id": strconv.FormatInt(user.ID, 10),
    "type":    "welcome",
})
q.Enqueue("send_email", string(payload))

http.WriteJSON(w, http.StatusCreated, user)
```

```go
// In the job worker
q.Handle("send_email", func(ctx context.Context, payload string) error {
    var data struct {
        UserID string `json:"user_id"`
        Type   string `json:"type"`
    }
    json.Unmarshal([]byte(payload), &data)

    // Look up user, build email, send
    // Returning an error triggers retry
    _, err := emailClient.Send(ctx, email.Message{
        To:      []string{user.Email},
        Subject: subject,
        HTML:    html,
        Text:    text,
    })
    return err
})
```

The queue handles retries automatically. If `Send` returns an error, the job is retried with backoff. This is useful for transient network errors or Resend API rate limits.

See the [Queue jobs](/docs/recipes/queue-jobs) recipe for the full job processing pattern.

---

## Per-message sender override

The `Message.From` field overrides the client-level default for a single email:

```go
emailClient.Send(ctx, email.Message{
    From:    "support@myapp.com",           // overrides the default
    To:      []string{"user@example.com"},
    Subject: "Your support ticket #1234",
    HTML:    ticketHTML,
    Text:    ticketText,
})
```

This is useful when different parts of the app send from different addresses (support, billing, notifications) while sharing one email client instance.

---

## Resend API errors

When the Resend API returns a non-2xx response, `Send` returns an `*email.APIError`:

```go
result, err := emailClient.Send(ctx, msg)
if err != nil {
    var apiErr *email.APIError
    if errors.As(err, &apiErr) {
        logger.Error("resend API error",
            log.Int("status", apiErr.StatusCode),
            log.String("body", apiErr.Body),
        )
        // 429 = rate limited, 400 = bad request, 500 = Resend outage
    }
}
```

Common Resend error codes:

| Status | Meaning | Action |
|--------|---------|--------|
| 400 | Bad request (invalid address, missing field) | Fix the request — don't retry |
| 401 | Invalid API key | Check `STANZA_EMAIL_RESEND_API_KEY` |
| 429 | Rate limited | Queue and retry with backoff |
| 500+ | Resend outage | Retry automatically via job queue |

---

## Rules

1. **Always include both HTML and Text.** Some clients only display plain text. Always provide a meaningful text fallback.
2. **Inline all CSS.** Email clients strip `<style>` blocks. Use `style=""` attributes on every element.
3. **Guard with `Configured()`.** Never call `Send` without checking first. Development should work with zero email config.
4. **Email errors are not user errors.** Log them, monitor them via `email.Stats()`, but almost never return them to the user. The user action (password reset, signup) should succeed regardless of email delivery.
5. **Queue bulk or non-urgent emails.** Keep HTTP responses fast. Use the job queue for welcome emails, digests, and anything that can tolerate a few seconds of delay.
