---
title: Validation
nextjs:
  metadata:
    title: Validation
    description: Field-level input validation with structured error responses.
---

The `pkg/validate` package provides field-level input validation that returns structured JSON error responses. It is designed for HTTP handler input — validate at the system boundary, not inside internal code.

```go
import "github.com/stanza-go/framework/pkg/validate"
```

---

## How it works

Create a `Validator` by passing a list of field checks to `Fields`. Each check returns `nil` on success or a `*FieldError` on failure. Only the first error per field is kept.

```go
v := validate.Fields(
    validate.Required("email", req.Email),
    validate.Required("password", req.Password),
    validate.MinLen("password", req.Password, 8),
    validate.Email("email", req.Email),
)
if v.HasErrors() {
    v.WriteError(w)
    return
}
```

`WriteError` sends a `422 Unprocessable Entity` response:

```json
{
  "error": "validation failed",
  "fields": {
    "password": "must be at least 8 characters"
  }
}
```

---

## Validators

### Required

Checks that a string is non-empty after trimming whitespace.

```go
validate.Required("name", req.Name)
// → "is required"
```

### MinLen / MaxLen

Checks string length bounds. Both skip empty strings — use `Required` to enforce presence.

```go
validate.MinLen("password", req.Password, 8)
// → "must be at least 8 characters"

validate.MaxLen("bio", req.Bio, 500)
// → "must be at most 500 characters"
```

### Email

Basic structural email check — local part, `@`, domain with a dot. Skips empty strings.

```go
validate.Email("email", req.Email)
// → "must be a valid email address"
```

### URL

Checks that a string is a valid HTTP or HTTPS URL — correct scheme, parseable, and has a host. Skips empty strings.

```go
validate.URL("callback_url", req.CallbackURL)
// → "must be a valid URL"
```

### PublicURL

Like `URL`, but also rejects URLs pointing to private or reserved addresses — loopback (127.x, ::1), private networks (10.x, 172.16-31.x, 192.168.x), link-local (169.254.x), and reserved hostnames (localhost, *.local, *.internal). Use this for webhook URLs and other cases where the server makes outbound requests to user-supplied URLs, to prevent SSRF attacks. Skips empty strings.

```go
validate.PublicURL("webhook_url", req.URL)
// → "must be a valid URL" (if malformed)
// → "must not point to a private or reserved address" (if internal)
```

### OneOf

Checks that a string is one of the allowed values. Skips empty strings.

```go
validate.OneOf("role", req.Role, "admin", "viewer", "editor")
// → "must be one of: admin, viewer, editor"
```

### FutureDate

Checks that a string is a valid RFC 3339 timestamp in the future. Skips empty strings.

```go
validate.FutureDate("expires_at", req.ExpiresAt)
// → "must be a valid ISO 8601 date" (if unparseable)
// → "must be a date in the future" (if in the past)
```

### Positive

Checks that an integer is greater than zero.

```go
validate.Positive("quantity", req.Quantity)
// → "must be a positive number"
```

### InRange

Checks that an integer is within `[min, max]` inclusive.

```go
validate.InRange("age", req.Age, 18, 120)
// → "must be between 18 and 120"
```

### Check

Generic validator for custom logic. If `ok` is false, the message is returned.

```go
validate.Check("end_date", req.EndDate > req.StartDate, "must be after start date")
validate.Check("quantity", req.Quantity <= stock, "exceeds available stock")
```

---

## Validator reference

| Function | Signature | Skips empty | Message |
|----------|-----------|-------------|---------|
| `Required` | `(field, value string)` | No | `is required` |
| `MinLen` | `(field, value string, min int)` | Yes | `must be at least N characters` |
| `MaxLen` | `(field, value string, max int)` | No | `must be at most N characters` |
| `Email` | `(field, value string)` | Yes | `must be a valid email address` |
| `URL` | `(field, value string)` | Yes | `must be a valid URL` |
| `PublicURL` | `(field, value string)` | Yes | `must be a valid URL` / `must not point to a private or reserved address` |
| `OneOf` | `(field, value string, ...allowed)` | Yes | `must be one of: a, b, c` |
| `FutureDate` | `(field, value string)` | Yes | `must be a valid ISO 8601 date` / `must be a date in the future` |
| `Positive` | `(field string, value int)` | — | `must be a positive number` |
| `InRange` | `(field string, value, min, max int)` | — | `must be between N and M` |
| `Check` | `(field string, ok bool, message string)` | — | Custom message |

---

## Ordering

Only the first error per field is kept. Put `Required` before format validators:

```go
v := validate.Fields(
    validate.Required("email", req.Email),    // checked first
    validate.Email("email", req.Email),       // skipped if already has error
)
```

If email is empty, the user sees `"is required"` — not `"must be a valid email address"`.

---

## Validator type

The `Validator` returned by `Fields` exposes three methods:

```go
v := validate.Fields(...)

v.HasErrors() bool              // true if any check failed
v.Errors() map[string]string    // field → message map (read-only)
v.WriteError(w)                 // write 422 JSON response
```

The `FieldError` type is public for advanced use cases:

```go
type FieldError struct {
    Field   string
    Message string
}
```

Each validator function returns `*FieldError` (nil on success). You can use this to build conditional validation:

```go
var checks []*validate.FieldError
checks = append(checks, validate.Required("name", req.Name))
if req.Type == "email" {
    checks = append(checks, validate.Required("email", req.Email))
    checks = append(checks, validate.Email("email", req.Email))
}
v := validate.Fields(checks...)
```

---

## Error response format

`WriteError` always produces the same structure:

```
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json

{"error":"validation failed","fields":{"field":"message"}}
```

Use `400 Bad Request` (via `http.WriteError`) for malformed input that can't be parsed. Use `422` (via `v.WriteError`) for structurally valid input with invalid field values.

---

## Tips

- **Validate at the boundary.** Only use `validate` in HTTP handlers. Internal functions should trust their callers.
- **One call per handler.** Collect all checks into a single `validate.Fields()` call.
- **Empty strings pass format validators.** `Email`, `MinLen`, `OneOf` skip empty values. Use `Required` to enforce presence.
- **Don't duplicate database constraints.** Unique, foreign key, and NOT NULL violations are database errors — handle them as 409 or 500, not 422.

See the [Input validation](/recipes/validation) recipe for practical handler examples and frontend integration patterns.
