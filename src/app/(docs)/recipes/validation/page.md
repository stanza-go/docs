---
title: Input validation
nextjs:
  metadata:
    title: Input validation
    description: How to validate request input with structured field-level errors.
---

The `pkg/validate` package provides field-level input validation that returns structured 422 responses. Validation errors are shown inline on forms in the admin panel and user frontend.

```go
import "github.com/stanza-go/framework/pkg/validate"
```

---

## Basic usage

Validate inside a handler after parsing the request body:

```go
func createHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        var req createRequest
        if !http.BindJSON(w, r, &req) {
            return
        }

        v := validate.Fields(
            validate.Required("name", req.Name),
            validate.Required("email", req.Email),
            validate.Email("email", req.Email),
            validate.Required("password", req.Password),
            validate.MinLen("password", req.Password, 8),
        )
        if v.HasErrors() {
            v.WriteError(w)
            return
        }

        // proceed with valid data
    }
}
```

`WriteError` sends a 422 response:

```json
{
  "error": "validation failed",
  "fields": {
    "name": "is required",
    "email": "must be a valid email address",
    "password": "must be at least 8 characters"
  }
}
```

---

## Available validators

| Validator | Check |
|-----------|-------|
| `Required(field, value)` | Non-empty after trimming whitespace |
| `MinLen(field, value, min)` | At least `min` characters (skips empty) |
| `MaxLen(field, value, max)` | At most `max` characters |
| `Email(field, value)` | Basic email format check (skips empty) |
| `URL(field, value)` | Valid HTTP/HTTPS URL (skips empty) |
| `PublicURL(field, value)` | Valid HTTP/HTTPS URL that doesn't point to private/reserved addresses (skips empty) |
| `OneOf(field, value, ...allowed)` | Value is one of the allowed strings (skips empty) |
| `FutureDate(field, value)` | Valid RFC 3339 timestamp in the future (skips empty) |
| `Positive(field, value)` | Integer greater than zero |
| `InRange(field, value, min, max)` | Integer within `[min, max]` inclusive |
| `Check(field, ok, message)` | Custom check — if `ok` is false, returns the message |

---

## Ordering matters

Only the first error per field is kept. Put `Required` before format validators for the same field:

```go
v := validate.Fields(
    validate.Required("email", req.Email),    // checked first
    validate.Email("email", req.Email),       // skipped if already has error
)
```

If email is empty, the user sees "is required" — not "must be a valid email address".

---

## Custom validation with Check

Use `Check` for logic that doesn't fit the built-in validators:

```go
v := validate.Fields(
    validate.Required("start_date", req.StartDate),
    validate.Required("end_date", req.EndDate),
    validate.Check("end_date", req.EndDate > req.StartDate, "must be after start date"),
    validate.Check("quantity", req.Quantity <= stock, "exceeds available stock"),
)
```

---

## Optional date fields

Use `FutureDate` for optional expiration or scheduling fields. It validates the RFC 3339 format and rejects past dates in one call:

```go
v := validate.Fields(
    validate.Required("name", req.Name),
    validate.FutureDate("expires_at", req.ExpiresAt),
)
```

If `expires_at` is empty, `FutureDate` passes (use `Required` if presence is mandatory). If provided, it must be parseable and in the future — otherwise the user sees `"must be a valid ISO 8601 date"` or `"must be a date in the future"`.

---

## Status codes

| Code | Meaning |
|------|---------|
| `400 Bad Request` | Malformed request — can't parse JSON, invalid path param |
| `422 Unprocessable Entity` | Valid JSON, but field values are invalid |

Use `http.WriteError(w, http.StatusBadRequest, msg)` for parse errors. Use `v.WriteError(w)` for validation errors.

---

## Frontend integration

The admin panel and user frontend display validation errors inline. When the API returns a response with a `fields` object, each field's error is shown below its input.

Example React pattern:

```tsx
const [errors, setErrors] = useState<Record<string, string>>({});

async function onSubmit(data: FormData) {
    const res = await fetch("/api/admin/products", {
        method: "POST",
        body: JSON.stringify(data),
    });
    if (!res.ok) {
        const body = await res.json();
        if (body.fields) {
            setErrors(body.fields);
            return;
        }
    }
}

// In the form:
<input name="name" />
{errors.name && <p className="text-sm text-red-600">{errors.name}</p>}
```

---

## Tips

- **Validate at the boundary.** Only validate user input in HTTP handlers. Internal code and framework calls don't need validation.
- **One validator call per handler.** Collect all checks into a single `validate.Fields()` call for a clean, scannable validation block.
- **Empty strings pass format validators.** `Email`, `MinLen`, `OneOf` all skip empty values. Use `Required` to enforce presence.
- **Don't validate what the database enforces.** Unique constraints, foreign keys, and NOT NULL are handled by SQLite — catch those as errors in the `db.Exec` response, not in validation.
