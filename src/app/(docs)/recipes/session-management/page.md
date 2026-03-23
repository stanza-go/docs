---
title: Session management
nextjs:
  metadata:
    title: Session management
    description: How Stanza handles authentication sessions — JWT access tokens, opaque refresh tokens, status polling, and revocation.
---

Stanza uses a hybrid stateless authentication strategy. Short-lived JWT access tokens handle authorization with zero database lookups. Opaque refresh tokens, stored as hashes in SQLite, provide persistent sessions with server-side revocation. This recipe covers the full session lifecycle.

---

## How sessions work

A session consists of two tokens:

| Token | Type | Lifetime | Storage | Purpose |
|-------|------|----------|---------|---------|
| Access token | JWT (HMAC-SHA256) | 5 minutes | `HttpOnly` cookie, broad path | Authorize API requests — no DB hit |
| Refresh token | Opaque (32 random bytes, hex) | 24 hours | `HttpOnly` cookie, auth path only | Refresh access tokens, server-side revocation |

The access token is trusted for its lifetime — the server never looks it up. The refresh token is hashed (SHA-256) and stored in the `refresh_tokens` table. Revocation means deleting the hash.

---

## The refresh_tokens table

Both admin and user sessions share one table, distinguished by `entity_type`:

```go
func createRefreshTokensUp(tx *sqlite.Tx) error {
    _, err := tx.Exec(`CREATE TABLE refresh_tokens (
        id          TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        token_hash  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`)
    if err != nil {
        return err
    }
    _, err = tx.Exec(`CREATE INDEX idx_refresh_tokens_entity ON refresh_tokens(entity_type, entity_id)`)
    if err != nil {
        return err
    }
    _, err = tx.Exec(`CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash)`)
    return err
}
```

| Column | Purpose |
|--------|---------|
| `id` | Random 16-byte hex identifier |
| `entity_type` | `"admin"` or `"user"` — allows multiple entity types in one table |
| `entity_id` | The admin or user ID (as string) |
| `token_hash` | SHA-256 hash of the raw refresh token — raw token is never stored |
| `expires_at` | Absolute expiration (RFC3339) — not rotated, not extended |

---

## Login: issuing tokens

Login validates credentials, then issues both tokens and sets cookies:

```go
func loginHandler(db *sqlite.DB, a *auth.Auth) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        var req struct {
            Email    string `json:"email"`
            Password string `json:"password"`
        }
        if err := http.ReadJSON(r, &req); err != nil {
            http.WriteError(w, http.StatusBadRequest, "invalid request body")
            return
        }

        // Look up the user.
        sql, args := sqlite.Select("id", "password", "name").
            From("users").
            Where("email = ?", req.Email).
            WhereNull("deleted_at").
            Where("is_active = 1").
            Build()

        var id int64
        var passwordHash, name string
        if err := db.QueryRow(sql, args...).Scan(&id, &passwordHash, &name); err != nil {
            http.WriteError(w, http.StatusUnauthorized, "invalid credentials")
            return
        }

        if !auth.VerifyPassword(passwordHash, req.Password) {
            http.WriteError(w, http.StatusUnauthorized, "invalid credentials")
            return
        }

        uid := strconv.FormatInt(id, 10)
        scopes := []string{"user"}

        // Issue JWT access token (5 min).
        accessToken, err := a.IssueAccessToken(uid, scopes)
        if err != nil {
            http.WriteError(w, http.StatusInternalServerError, "internal error")
            return
        }
        a.SetAccessTokenCookie(w, accessToken)

        // Generate and store refresh token (24 hours).
        refreshToken, err := auth.GenerateRefreshToken()
        if err != nil {
            http.WriteError(w, http.StatusInternalServerError, "internal error")
            return
        }
        tokenHash := auth.HashToken(refreshToken)
        now := time.Now().UTC()
        expiresAt := now.Add(a.RefreshTokenTTL()).Format(time.RFC3339)

        sql, args = sqlite.Insert("refresh_tokens").
            Set("id", randomID()).
            Set("entity_type", "user").
            Set("entity_id", uid).
            Set("token_hash", tokenHash).
            Set("expires_at", expiresAt).
            Build()
        if _, err := db.Exec(sql, args...); err != nil {
            http.WriteError(w, http.StatusInternalServerError, "internal error")
            return
        }

        a.SetRefreshTokenCookie(w, refreshToken)

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "user": map[string]any{"id": id, "email": req.Email, "name": name},
        })
    }
}
```

The refresh token stored in the cookie is the raw hex string. The database only ever sees the SHA-256 hash.

{% callout title="Credential errors" %}
Both "email not found" and "wrong password" return the same `"invalid credentials"` message. This prevents email enumeration attacks.
{% /callout %}

---

## Status polling: refreshing access tokens

The frontend polls a status endpoint every ~1 minute. This endpoint validates the refresh token, checks the user is still active, and issues a fresh access token:

```go
func statusHandler(db *sqlite.DB, a *auth.Auth) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        refreshToken, err := auth.ReadRefreshToken(r)
        if err != nil {
            http.WriteError(w, http.StatusUnauthorized, "authentication required")
            return
        }

        // Look up the refresh token by hash.
        tokenHash := auth.HashToken(refreshToken)
        sql, args := sqlite.Select("entity_id", "expires_at").
            From("refresh_tokens").
            Where("token_hash = ?", tokenHash).
            Where("entity_type = ?", "user").
            Build()

        var entityID, expiresAt string
        if err := db.QueryRow(sql, args...).Scan(&entityID, &expiresAt); err != nil {
            a.ClearAllCookies(w)
            http.WriteError(w, http.StatusUnauthorized, "authentication required")
            return
        }

        // Check expiration.
        exp, _ := time.Parse(time.RFC3339, expiresAt)
        if time.Now().UTC().After(exp) {
            // Expired — clean up and reject.
            sql, args = sqlite.Delete("refresh_tokens").
                Where("token_hash = ?", tokenHash).Build()
            _, _ = db.Exec(sql, args...)
            a.ClearAllCookies(w)
            http.WriteError(w, http.StatusUnauthorized, "session expired")
            return
        }

        // Verify the user still exists and is active.
        sql, args = sqlite.Select("id", "email", "name").
            From("users").
            Where("id = ?", entityID).
            WhereNull("deleted_at").
            Where("is_active = 1").
            Build()

        var id int64
        var email, name string
        if err := db.QueryRow(sql, args...).Scan(&id, &email, &name); err != nil {
            // User deleted or deactivated — revoke session.
            sql, args = sqlite.Delete("refresh_tokens").
                Where("token_hash = ?", tokenHash).Build()
            _, _ = db.Exec(sql, args...)
            a.ClearAllCookies(w)
            http.WriteError(w, http.StatusUnauthorized, "account deactivated")
            return
        }

        // Issue a fresh access token with current scopes.
        accessToken, err := a.IssueAccessToken(strconv.FormatInt(id, 10), []string{"user"})
        if err != nil {
            http.WriteError(w, http.StatusInternalServerError, "internal error")
            return
        }
        a.SetAccessTokenCookie(w, accessToken)

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "user": map[string]any{"id": id, "email": email, "name": name},
        })
    }
}
```

Key behaviors:

- The refresh token is **not rotated** — the same token works for its full 24-hour lifetime. This makes multi-tab safe (no race conditions between tabs trying to use a rotated token).
- Each poll issues a **fresh access token** with up-to-date scopes. If an admin changes a user's role, the new scopes take effect within 1 minute.
- If the user is deleted or deactivated, the refresh token is revoked and cookies are cleared.

---

## Logout: revoking a session

Logout deletes the refresh token hash from the database and clears both cookies:

```go
func logoutHandler(db *sqlite.DB, a *auth.Auth) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        refreshToken, err := auth.ReadRefreshToken(r)
        if err == nil {
            tokenHash := auth.HashToken(refreshToken)
            sql, args := sqlite.Delete("refresh_tokens").
                Where("token_hash = ?", tokenHash).Build()
            _, _ = db.Exec(sql, args...)
        }

        a.ClearAllCookies(w)

        http.WriteJSON(w, http.StatusOK, map[string]any{"status": "logged out"})
    }
}
```

After logout, the refresh token can never be reused. The access token remains technically valid until it expires (up to 5 minutes), but the cookie is cleared so the browser won't send it.

---

## Admin session management

The admin panel provides endpoints to list and revoke sessions across all entity types:

```go
func Register(admin *http.Group, db *sqlite.DB, wh *webhooks.Dispatcher) {
    admin.HandleFunc("GET /sessions", listHandler(db))
    admin.HandleFunc("DELETE /sessions/{id}", revokeHandler(db, wh))
    admin.HandleFunc("POST /sessions/bulk-revoke", bulkRevokeHandler(db, wh))
}
```

### Listing active sessions

Query non-expired refresh tokens with a LEFT JOIN to resolve entity names:

```go
now := sqlite.Now()

sql, args := sqlite.Select(
    "rt.id", "rt.entity_type", "rt.entity_id",
    "rt.created_at", "rt.expires_at",
    sqlite.CoalesceEmpty("a.email"), sqlite.CoalesceEmpty("a.name")).
    From("refresh_tokens rt").
    LeftJoin("admins a", "rt.entity_type = 'admin' AND rt.entity_id = CAST(a.id AS TEXT)").
    Where("rt.expires_at > ?", now).
    OrderBy("rt.created_at", "DESC").
    Build()
```

### Revoking a single session

Delete by the refresh token's row ID (not the token hash — admins see the ID, not the token):

```go
sql, args := sqlite.Delete("refresh_tokens").Where("id = ?", id).Build()
result, err := db.Exec(sql, args...)
if result.RowsAffected == 0 {
    http.WriteError(w, http.StatusNotFound, "session not found")
    return
}
```

### Bulk revocation

Accept an array of IDs and delete them in one query:

```go
ids := make([]any, len(req.IDs))
for i, id := range req.IDs {
    ids[i] = id
}

sql, args := sqlite.Delete("refresh_tokens").
    WhereIn("id", ids...).
    Build()
result, err := db.Exec(sql, args...)
```

---

## Cookie configuration

Access and refresh tokens are stored in separate cookies with different path scopes:

| Cookie | Path (admin) | Path (user) | MaxAge | Flags |
|--------|-------------|-------------|--------|-------|
| `access_token` | `/api/admin` | `/api` | 5 min | `HttpOnly`, `Secure`, `SameSite=Lax` |
| `refresh_token` | `/api/admin/auth` | `/api/auth` | 24 hours | `HttpOnly`, `Secure`, `SameSite=Lax` |

The refresh token cookie uses a restricted path — it's only sent to auth endpoints (`/auth`, `/auth/logout`), never to regular API handlers. This limits exposure.

```go
// Admin auth instance — cookies scoped to /api/admin.
adminAuth := auth.New(signingKey,
    auth.WithCookiePath("/api/admin"),
    auth.WithSecureCookies(true),
)

// User auth instance — cookies scoped to /api.
userAuth := auth.New(signingKey,
    auth.WithCookiePath("/api"),
    auth.WithSecureCookies(true),
)
```

{% callout title="Local development" %}
Set `STANZA_AUTH_SECURE_COOKIES=false` during local development. Without HTTPS, browsers reject `Secure` cookies and authentication silently fails.
{% /callout %}

---

## Revocation window

The maximum time between revoking a session and the access token becoming unusable is **5 minutes** (the access token TTL). In practice, the 1-minute polling interval catches revocations sooner — the frontend detects the 401 response and redirects to login.

| Action | Effect | Delay |
|--------|--------|-------|
| Delete refresh token from DB | Next status poll returns 401 | Up to 1 minute (polling interval) |
| Access token expires naturally | API requests start failing | Up to 5 minutes (token TTL) |
| Clear cookies on client | Browser stops sending tokens | Immediate (on logout) |

For immediate revocation (e.g., compromised account), combine: delete the refresh token, deactivate the user, and rely on the short access token TTL.

---

## The rules

1. **Never store raw refresh tokens.** Always hash with `auth.HashToken()` (SHA-256) before writing to the database.

2. **Don't rotate refresh tokens.** A single token is valid for its full 24-hour lifetime. Rotation causes race conditions in multi-tab scenarios.

3. **Use separate Auth instances for admins and users.** Different cookie paths prevent tokens from leaking across contexts.

4. **Poll status every ~1 minute.** This refreshes the access token, catches revocations, and updates scopes.

5. **Return generic auth errors.** Login failures always say `"invalid credentials"` — never reveal whether the email exists.

6. **Clean up on deactivation.** When an admin deactivates a user, the next status poll revokes the session automatically. No need to manually clean up refresh tokens.

7. **Set `Secure: false` only for local dev.** Production must always use HTTPS with secure cookies.
