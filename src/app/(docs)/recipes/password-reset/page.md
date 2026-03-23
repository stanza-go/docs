---
title: Password reset
nextjs:
  metadata:
    title: Password reset
    description: How to implement a secure password reset flow with email tokens.
---

The standalone app includes a complete password reset flow — request a reset email, validate the token, and update the password. This recipe explains the pattern so you can adapt it or add similar token-based flows.

---

## How it works

The flow is two API calls:

1. **`POST /api/auth/forgot-password`** — User submits their email. The server generates a random token, stores its hash, and sends the token via email. Always returns 200 (prevents email enumeration).

2. **`POST /api/auth/reset-password`** — User submits the token and a new password. The server validates the token, updates the password, and revokes all existing sessions.

---

## Migration

The `password_reset_tokens` table stores hashed tokens:

```go
func (m *CreatePasswordResetTokens) Up(db *sqlite.DB) error {
    _, err := db.Exec(`CREATE TABLE password_reset_tokens (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    return err
}
```

---

## Requesting a reset

```go
// POST /api/auth/forgot-password
// Body: {"email": "user@example.com"}

// 1. Validate email format
v := validate.Fields(
    validate.Required("email", req.Email),
    validate.Email("email", req.Email),
)

// 2. Look up user — if not found, return 200 anyway
sql, args := sqlite.Select("id").
    From("users").
    Where("email = ?", email).
    WhereNull("deleted_at").
    Where("is_active = ?", true).
    Build()
row := db.QueryRow(sql, args...)
if err := row.Scan(&userID); err != nil {
    // User not found — return success to prevent enumeration
    http.WriteJSON(w, http.StatusOK, successResponse)
    return
}

// 3. Invalidate existing unused tokens for this email
_, _ = db.Update(sqlite.Update("password_reset_tokens").
    Set("used_at", sqlite.Now()).
    Where("email = ?", email).
    WhereNull("used_at"))

// 4. Generate token (32 bytes = 64 hex chars), store SHA256 hash
token := generateToken()  // crypto/rand
tokenHash := auth.HashToken(token)
_, _ = db.Insert(sqlite.Insert("password_reset_tokens").
    Set("email", email).
    Set("token_hash", tokenHash).
    Set("expires_at", /* 30 minutes from now */).
    Set("created_at", sqlite.Now()))

// 5. Send email with the raw token
client.Send(ctx, email.Message{
    To:      []string{userEmail},
    Subject: "Password Reset",
    HTML:    htmlTemplate,
})
```

---

## Confirming the reset

```go
// POST /api/auth/reset-password
// Body: {"token": "abc123...", "password": "new-password"}

// 1. Hash the submitted token and look it up
tokenHash := auth.HashToken(req.Token)
sql, args := sqlite.Select("id", "email", "expires_at").
    From("password_reset_tokens").
    Where("token_hash = ?", tokenHash).
    WhereNull("used_at").
    Build()
row := db.QueryRow(sql, args...)

// 2. Check expiration (30 minute TTL)
if time.Now().After(expiresAt) {
    http.WriteError(w, http.StatusBadRequest, "reset token has expired")
    return
}

// 3. Update password
passwordHash, _ := auth.HashPassword(req.Password)
_, _ = db.Update(sqlite.Update("users").
    Set("password", passwordHash).
    Where("email = ?", tokenEmail))

// 4. Mark token as used
_, _ = db.Update(sqlite.Update("password_reset_tokens").
    Set("used_at", sqlite.Now()).
    Where("id = ?", tokenID))

// 5. Revoke all refresh tokens — forces re-login
_, _ = db.Delete(sqlite.Delete("refresh_tokens").
    Where("entity_type = ?", "user").
    Where("entity_id = ?", userID))
```

---

## Security design

| Decision | Rationale |
|----------|-----------|
| **30-minute TTL** | Short enough to limit exposure, long enough for the user to check email |
| **SHA256 hashed storage** | Raw token never stored in DB — database compromise doesn't leak usable tokens |
| **Always returns 200** | `POST /forgot-password` returns success even for unknown emails — prevents email enumeration |
| **Invalidate old tokens** | New request invalidates all existing unused tokens for the same email |
| **Revoke all sessions** | After password change, all refresh tokens are deleted — forces re-login on all devices |
| **32 bytes of randomness** | 64 hex characters from `crypto/rand` — brute force is infeasible |

---

## Automatic cleanup

The built-in `purge-old-reset-tokens` cron job runs daily at 4:30 AM and deletes expired or used tokens older than 7 days.

---

## Testing

```bash
# Request a reset
curl -s -X POST http://localhost:23710/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'

# Confirm the reset (use the token from the email or server logs)
curl -s -X POST http://localhost:23710/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{"token": "abc123...", "password": "new-secure-password"}'
```

In local development without Resend configured, the token is logged at `WARN` level so you can copy it from the console.

---

## Tips

- **Email is best-effort.** If Resend is down, the token is still stored. The user can request another reset.
- **No rate limiting on forgot-password.** The auth route group already has rate limiting (20 req/min per IP). No additional rate limiting needed.
- **Adapt for admin password reset.** Fork the module, change the table from `users` to `admins`, and register under `/api/admin/auth`.
