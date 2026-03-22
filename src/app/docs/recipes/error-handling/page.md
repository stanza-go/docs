---
title: Error handling patterns
nextjs:
  metadata:
    title: Error handling patterns
    description: Consistent error handling in Stanza — validation, not found, conflicts, auth, panics, and the rules that keep it clean.
---

This recipe covers the error handling conventions used throughout a Stanza app — how handlers return errors, which HTTP status codes to use, and the Go patterns that keep error handling consistent and safe.

---

## Error response format

All error responses use a consistent JSON structure:

```json
{"error": "human-readable message"}
```

For validation errors, field-level details are included:

```json
{
  "error": "validation failed",
  "fields": {
    "email": "must be a valid email address",
    "password": "must be at least 8 characters"
  }
}
```

The framework provides two helpers for writing error responses:

```go
// Simple error — single message
http.WriteError(w, http.StatusNotFound, "user not found")

// Validation error — per-field messages (422)
v := validate.Fields(
    validate.Required("email", req.Email),
    validate.Email("email", req.Email),
)
if v.HasErrors() {
    v.WriteError(w)
    return
}
```

---

## Status code guide

| Situation | Status | Code | Example message |
|-----------|--------|------|-----------------|
| Malformed JSON, bad path param | 400 | `StatusBadRequest` | `"invalid request body"` |
| Validation failure | 422 | `StatusUnprocessableEntity` | `"validation failed"` (+ fields) |
| Missing or invalid credentials | 401 | `StatusUnauthorized` | `"authentication required"` |
| Valid credentials, wrong scope | 403 | `StatusForbidden` | `"insufficient permissions"` |
| Resource doesn't exist | 404 | `StatusNotFound` | `"user not found"` |
| Unique constraint violation | 409 | `StatusConflict` | `"email already exists"` |
| Too many requests | 429 | `StatusTooManyRequests` | `"too many requests"` |
| Database or system failure | 500 | `StatusInternalServerError` | `"failed to create user"` |

---

## Invalid input (400)

Return 400 when the request can't even be parsed — malformed JSON, unparseable path parameters, or body too large:

```go
// Bad JSON body
var req createRequest
if err := http.ReadJSON(r, &req); err != nil {
    http.WriteError(w, http.StatusBadRequest, "invalid request body")
    return
}

// Bad path parameter
id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
if err != nil {
    http.WriteError(w, http.StatusBadRequest, "invalid user id")
    return
}
```

The distinction from 422: **400 means the request is structurally broken** (can't decode). 422 means the structure is fine but the values are wrong (email is empty, password too short).

---

## Validation (422)

Use `pkg/validate` for field-level validation. It collects errors across all fields and returns them in one response:

```go
v := validate.Fields(
    validate.Required("name", req.Name),
    validate.MaxLen("name", req.Name, 255),
    validate.Required("email", req.Email),
    validate.Email("email", req.Email),
    validate.MinLen("password", req.Password, 8),
    validate.OneOf("role", req.Role, "admin", "editor", "viewer"),
    validate.Positive("age", req.Age),
    validate.InRange("priority", req.Priority, 1, 5),
)
if v.HasErrors() {
    v.WriteError(w) // 422 with per-field errors
    return
}
```

For custom validation logic, use `Check`:

```go
v := validate.Fields(
    validate.Required("start_date", req.StartDate),
    validate.Required("end_date", req.EndDate),
    validate.Check("end_date", endTime.After(startTime), "must be after start date"),
)
```

### Available validators

| Validator | Message |
|-----------|---------|
| `Required(field, value)` | `"is required"` |
| `MinLen(field, value, min)` | `"must be at least N characters"` |
| `MaxLen(field, value, max)` | `"must be at most N characters"` |
| `Email(field, value)` | `"must be a valid email address"` |
| `OneOf(field, value, allowed...)` | `"must be one of: a, b, c"` |
| `Positive(field, value)` | `"must be a positive number"` |
| `InRange(field, value, min, max)` | `"must be between N and M"` |
| `Check(field, ok, message)` | Custom message |

---

## Not found (404)

Two patterns for detecting "not found" depending on the query type.

### QueryRow: check Scan error

When fetching a single row, `Scan` returns `sqlite.ErrNoRows` if no row matches:

```go
sql, args := sqlite.Select("id", "name", "email").
    From("users").
    Where("id = ?", id).
    Where("deleted_at IS NULL").
    Build()

if err := db.QueryRow(sql, args...).Scan(&u.ID, &u.Name, &u.Email); err != nil {
    http.WriteError(w, http.StatusNotFound, "user not found")
    return
}
```

### Exec: check RowsAffected

After an UPDATE or DELETE, check whether any rows were actually changed:

```go
sql, args := sqlite.Update("users").
    Set("deleted_at", now).
    Where("id = ?", id).
    Where("deleted_at IS NULL").
    Build()

result, err := db.Exec(sql, args...)
if err != nil {
    http.WriteError(w, http.StatusInternalServerError, "failed to delete user")
    return
}
if result.RowsAffected == 0 {
    http.WriteError(w, http.StatusNotFound, "user not found")
    return
}
```

---

## Conflicts (409)

Detect UNIQUE constraint violations by inspecting the error message from SQLite:

```go
result, err := db.Exec(sql, args...)
if err != nil {
    if strings.Contains(err.Error(), "UNIQUE constraint failed") {
        http.WriteError(w, http.StatusConflict, "email already exists")
        return
    }
    http.WriteError(w, http.StatusInternalServerError, "failed to create user")
    return
}
```

{% callout title="String matching" %}
SQLite error messages include the constraint name (e.g., `"UNIQUE constraint failed: users.email"`). String matching is the correct approach here — SQLite's C API returns these as text, and the `pkg/sqlite` package surfaces them as wrapped errors.
{% /callout %}

---

## Authentication and authorization (401/403)

Auth errors are handled by middleware, not by individual handlers. The framework's `auth` package provides two middleware:

```go
// Validates JWT access token — returns 401 if missing, expired, or invalid
admin.Use(a.RequireAuth())

// Checks scope claim — returns 403 if the scope is missing
admin.Use(auth.RequireScope("admin"))
admin.Use(auth.RequireScope("admin:users"))
```

For login endpoints that validate credentials directly, use a generic message to prevent email enumeration:

```go
if err := db.QueryRow(sql, args...).Scan(&id, &passwordHash); err != nil {
    // Don't reveal whether the email exists
    http.WriteError(w, http.StatusUnauthorized, "invalid credentials")
    return
}
```

For business logic authorization (not scope-based), use 400:

```go
if isActive == 0 {
    http.WriteError(w, http.StatusBadRequest, "cannot impersonate an inactive user")
    return
}
```

---

## Internal errors (500)

Return 500 for failures the client can't fix — database errors, encoding failures, crypto failures:

```go
rows, err := db.Query(sql, args...)
if err != nil {
    http.WriteError(w, http.StatusInternalServerError, "failed to list users")
    return
}
defer rows.Close()
```

The error message should be **generic but descriptive** — tell the client what operation failed without exposing internals. Never include the raw error in the response:

```go
// Good: tells the client what failed
http.WriteError(w, http.StatusInternalServerError, "failed to create user")

// Bad: leaks internal details
http.WriteError(w, http.StatusInternalServerError, err.Error())
```

For sensitive operations (token generation, encryption), log the real error and return a generic message:

```go
token, err := a.IssueAccessToken(uid, scopes)
if err != nil {
    logger.Error("issue access token", log.String("error", err.Error()))
    http.WriteError(w, http.StatusInternalServerError, "internal error")
    return
}
```

---

## Panic recovery

The `Recovery` middleware catches panics and converts them to 500 responses:

```go
router.Use(http.Recovery(func(v any, stack []byte) {
    logger.Error("panic recovered",
        log.Any("error", v),
        log.String("stack", string(stack)),
    )
}))
```

This prevents a single panic from crashing the process. The client gets `{"error": "internal server error"}` and the panic is logged with a full stack trace.

{% callout title="Recovery placement" type="warning" %}
Place `Recovery` as the last global middleware so it catches panics from all downstream middleware and handlers. If it's placed before `RequestLogger`, the logger won't see the 500 status.
{% /callout %}

---

## Row iteration errors

Always check `rows.Err()` after a `for rows.Next()` loop. If `Next()` returns `false` due to an error (not just end-of-results), `Err()` returns that error:

```go
rows, err := db.Query(sql, args...)
if err != nil {
    http.WriteError(w, http.StatusInternalServerError, "failed to list users")
    return
}
defer rows.Close()

users := make([]userJSON, 0)
for rows.Next() {
    var u userJSON
    if err := rows.Scan(&u.ID, &u.Name, &u.Email); err != nil {
        http.WriteError(w, http.StatusInternalServerError, "failed to scan user")
        return
    }
    users = append(users, u)
}
if err := rows.Err(); err != nil {
    http.WriteError(w, http.StatusInternalServerError, "failed to iterate users")
    return
}
```

---

## Silent error handling

Some errors are intentionally ignored — optional operations where failure shouldn't block the response:

```go
// Webhook dispatch is best-effort
_ = wh.Dispatch(r.Context(), "user.created", map[string]any{"user_id": id})

// Count query failure defaults to 0 — the list still works
var total int
sql, args := sqlite.CountFrom(selectQ).Build()
_ = db.QueryRow(sql, args...).Scan(&total)
```

When ignoring errors, use `_` explicitly to make the intent clear. Never swallow errors silently — either handle them, return them, or assign them to `_`.

---

## The rules

1. **Handle errors once.** Either log the error or return it — never both. Logging is handling. If you log and return, the caller logs it again.

2. **Return after writing an error.** Always `return` after `http.WriteError()` or `v.WriteError()`. Without the return, the handler continues executing with invalid state.

3. **Generic messages for 500s.** Tell the client what operation failed, not why. Log the real error server-side.

4. **Specific messages for 4xxs.** The client can act on "email already exists" or "password must be at least 8 characters" — give them useful feedback.

5. **No error wrapping in handlers.** Handlers are the end of the chain — they write a response. Wrapping (`fmt.Errorf("...: %w", err)`) is for library code that returns errors to callers.

6. **Close transient resources.** Always `defer rows.Close()` after `db.Query()`. Always close `r.Body` in custom HTTP clients. Any type with `Close()` is a resource that must be released.

7. **Check `rows.Err()`.** A `for rows.Next()` loop that exits normally might have encountered an error. Always check.

8. **Use `_` for intentional ignores.** Don't let errors vanish — make the decision explicit.
