---
title: User authentication
nextjs:
  metadata:
    title: User authentication
    description: How to build user registration, login, JWT-protected routes, and cross-user data isolation.
---

The standalone app ships with a complete user authentication flow — registration, login, token refresh, and logout. This recipe covers the full pattern and how to add protected, user-scoped endpoints to your modules.

---

## How it works

User authentication uses the same hybrid JWT strategy as admin authentication, with a separate cookie path:

| Token | Lifetime | Cookie path | Purpose |
|-------|----------|-------------|---------|
| Access token (JWT) | 5 minutes | `/api` | Authorize requests — no DB hit |
| Refresh token (opaque) | 24 hours | `/api/auth` | Refresh access tokens, server-side revocation |

Two auth instances exist in a typical Stanza app — one for admins (`/api/admin`) and one for users (`/api`). Both share the same signing key but use different cookie paths so their tokens don't overlap.

---

## API endpoints

```
POST  /api/auth/register         — create account + auto-login
POST  /api/auth/login            — authenticate with email + password
GET   /api/auth                  — status check + token refresh
POST  /api/auth/logout           — revoke session + clear cookies
POST  /api/auth/forgot-password  — request password reset email
POST  /api/auth/reset-password   — confirm reset with token + new password
```

---

## Registration

The register handler creates a user, hashes the password, and immediately issues a session:

```go
func (m *Module) registerHandler(w http.ResponseWriter, r *http.Request) {
    var body struct {
        Email    string `json:"email"`
        Password string `json:"password"`
        Name     string `json:"name"`
    }
    if err := http.ReadJSON(r, &body); err != nil {
        http.WriteError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    // Validate
    v := validation.New()
    v.Check("email", validation.Email(body.Email))
    v.Check("password", validation.MinLength(body.Password, 8))
    v.Check("name", validation.Required(body.Name))
    if !v.Valid() {
        http.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{
            "errors": v.Errors(),
        })
        return
    }

    // Check duplicate
    exists, _ := sqlite.Select("1").
        From("users").
        Where("email = ?", body.Email).
        WhereNull("deleted_at").
        Exists(m.db)
    if exists {
        http.WriteError(w, http.StatusConflict, "email already registered")
        return
    }

    // Create user
    hash, _ := auth.HashPassword(body.Password)
    res, err := sqlite.Insert("users").
        Set("email", body.Email).
        Set("password_hash", hash).
        Set("name", body.Name).
        Set("is_active", true).
        Exec(m.db)
    if err != nil {
        http.WriteError(w, http.StatusInternalServerError, "failed to create user")
        return
    }
    userID, _ := res.LastInsertId()

    // Auto-login — issue tokens
    m.issueSession(w, userID, body.Email, body.Name)
}
```

The key points:

- **Hash before storing.** `auth.HashPassword` uses bcrypt. Never store plaintext passwords.
- **Auto-login after registration.** Call `issueSession` to set cookies immediately — no redirect to a separate login page.
- **Duplicate check with `WhereNull("deleted_at")`.** Soft-deleted users don't block re-registration with the same email.

---

## Login

Login queries by email, verifies the password hash, then issues tokens:

```go
func (m *Module) loginHandler(w http.ResponseWriter, r *http.Request) {
    var body struct {
        Email    string `json:"email"`
        Password string `json:"password"`
    }
    if err := http.ReadJSON(r, &body); err != nil {
        http.WriteError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    // Look up user
    var user struct {
        ID           int64
        Email        string
        Name         string
        PasswordHash string
        IsActive     bool
    }
    err := sqlite.Select("id", "email", "name", "password_hash", "is_active").
        From("users").
        Where("email = ?", body.Email).
        WhereNull("deleted_at").
        QueryRow(m.db, &user.ID, &user.Email, &user.Name, &user.PasswordHash, &user.IsActive)
    if err != nil {
        // Same error for missing user and wrong password — prevents email enumeration
        http.WriteError(w, http.StatusUnauthorized, "invalid email or password")
        return
    }

    if !user.IsActive {
        http.WriteError(w, http.StatusForbidden, "account deactivated")
        return
    }

    // Verify password — constant-time comparison
    if !auth.CheckPassword(user.PasswordHash, body.Password) {
        http.WriteError(w, http.StatusUnauthorized, "invalid email or password")
        return
    }

    m.issueSession(w, user.ID, user.Email, user.Name)
}
```

**Anti-enumeration.** The same `"invalid email or password"` message is returned for both missing users and wrong passwords. An attacker cannot determine which emails are registered.

---

## Issuing a session

Both registration and login call a shared helper that creates both tokens and sets cookies:

```go
func (m *Module) issueSession(w http.ResponseWriter, userID int64, email, name string) {
    uid := sqlite.FormatID(userID)

    // Issue JWT access token (5 min)
    accessToken, _ := m.auth.IssueAccessToken(uid, []string{"user"})

    // Generate opaque refresh token (24h) and store its hash
    refreshRaw, _ := auth.GenerateRefreshToken()
    tokenHash := auth.HashToken(refreshRaw)
    tokenID, _ := auth.GenerateTokenID()

    sqlite.Insert("refresh_tokens").
        Set("id", tokenID).
        Set("entity_type", "user").
        Set("entity_id", uid).
        Set("token_hash", tokenHash).
        Set("expires_at", time.Now().Add(24*time.Hour).UTC().Format(time.RFC3339)).
        Exec(m.db)

    // Set HttpOnly cookies
    m.auth.SetAccessTokenCookie(w, accessToken)
    m.auth.SetRefreshTokenCookie(w, refreshRaw)

    http.WriteJSON(w, http.StatusCreated, map[string]any{
        "user": map[string]any{
            "id":    userID,
            "email": email,
            "name":  name,
        },
    })
}
```

The access token cookie is scoped to `/api` (all API routes) while the refresh token cookie is scoped to `/api/auth` (auth endpoints only). This prevents the refresh token from being sent on every API request.

---

## Status and token refresh

The frontend polls `GET /api/auth` every ~60 seconds. This endpoint validates the refresh token, checks if the user is still active, and issues a fresh access token:

```go
func (m *Module) statusHandler(w http.ResponseWriter, r *http.Request) {
    raw, err := auth.ReadRefreshToken(r)
    if err != nil {
        http.WriteError(w, http.StatusUnauthorized, "no session")
        return
    }

    // Look up refresh token hash
    tokenHash := auth.HashToken(raw)
    var tokenID, entityID, expiresAt string
    err = sqlite.Select("id", "entity_id", "expires_at").
        From("refresh_tokens").
        Where("token_hash = ?", tokenHash).
        Where("entity_type = ?", "user").
        QueryRow(m.db, &tokenID, &entityID, &expiresAt)
    if err != nil {
        http.WriteError(w, http.StatusUnauthorized, "invalid session")
        return
    }

    // Check expiry
    exp, _ := time.Parse(time.RFC3339, expiresAt)
    if time.Now().After(exp) {
        sqlite.Delete("refresh_tokens").Where("id = ?", tokenID).Exec(m.db)
        m.auth.ClearCookies(w)
        http.WriteError(w, http.StatusUnauthorized, "session expired")
        return
    }

    // Check user is still active
    var isActive bool
    var email, name string
    err = sqlite.Select("is_active", "email", "name").
        From("users").
        Where("id = ?", entityID).
        QueryRow(m.db, &isActive, &email, &name)
    if err != nil || !isActive {
        m.auth.ClearCookies(w)
        http.WriteError(w, http.StatusUnauthorized, "account deactivated")
        return
    }

    // Issue fresh access token with current scopes
    accessToken, _ := m.auth.IssueAccessToken(entityID, []string{"user"})
    m.auth.SetAccessTokenCookie(w, accessToken)

    http.WriteJSON(w, http.StatusOK, map[string]any{
        "user": map[string]any{"id": entityID, "email": email, "name": name},
    })
}
```

This polling pattern means revocation takes at most ~60 seconds to take effect, rather than waiting for the 5-minute access token to expire.

---

## Logout

Logout revokes the refresh token and clears both cookies:

```go
func (m *Module) logoutHandler(w http.ResponseWriter, r *http.Request) {
    raw, err := auth.ReadRefreshToken(r)
    if err == nil {
        tokenHash := auth.HashToken(raw)
        sqlite.Delete("refresh_tokens").
            Where("token_hash = ?", tokenHash).
            Exec(m.db)
    }
    m.auth.ClearCookies(w)
    http.WriteJSON(w, http.StatusOK, map[string]any{"message": "logged out"})
}
```

---

## Protecting routes

User-facing routes are grouped under `/api/user` with two middleware layers:

```go
// In main.go — wire up user routes
user := api.Group("/user")
user.Use(ua.RequireAuthOrAPIKey(apiKeyValidator))
user.Use(auth.RequireScope("user"))

// All handlers under /api/user are now protected:
userprofile.Register(user, db)
usersettings.Register(user, db)
useruploads.Register(user, db, uploadsDir)
```

| Middleware | What it does |
|-----------|--------------|
| `RequireAuthOrAPIKey` | Tries JWT from cookie first, falls back to `Authorization: Bearer` API key |
| `RequireScope("user")` | Rejects requests where the token doesn't have the `"user"` scope |

Both middleware layers store the authenticated claims in the request context. Any handler downstream can retrieve them.

---

## Extracting user identity

Inside a protected handler, get the authenticated user's ID from the context:

```go
func (m *Module) getProfileHandler(w http.ResponseWriter, r *http.Request) {
    claims, ok := auth.ClaimsFromContext(r.Context())
    if !ok {
        http.WriteError(w, http.StatusUnauthorized, "authentication required")
        return
    }

    // claims.UID is the user's ID (string)
    // claims.Scopes is []string{"user"}
    var email, name string
    err := sqlite.Select("email", "name").
        From("users").
        Where("id = ?", claims.UID).
        QueryRow(m.db, &email, &name)
    if err != nil {
        http.WriteError(w, http.StatusNotFound, "user not found")
        return
    }

    http.WriteJSON(w, http.StatusOK, map[string]any{
        "user": map[string]any{"id": claims.UID, "email": email, "name": name},
    })
}
```

---

## Cross-user data isolation

Every user-facing query must include the user's ID in its WHERE clause. This is the single most important security pattern:

```go
// List only this user's bookmarks
sql, args := sqlite.Select("id", "url", "title", "created_at").
    From("bookmarks").
    Where("user_id = ?", claims.UID).
    OrderBy("created_at", "DESC").
    Paginate(page).
    Build()
```

```go
// Update — verify ownership
res, err := sqlite.Update("bookmarks").
    Set("title", body.Title).
    Set("url", body.URL).
    Where("id = ?", id).
    Where("user_id = ?", claims.UID).  // prevents updating other users' data
    Exec(m.db)

rows, _ := res.RowsAffected()
if rows == 0 {
    http.WriteError(w, http.StatusNotFound, "bookmark not found")
    return
}
```

```go
// Delete — verify ownership
sqlite.Delete("bookmarks").
    Where("id = ?", id).
    Where("user_id = ?", claims.UID).
    Exec(m.db)
```

**Always add `Where("user_id = ?", claims.UID)` to every query.** Never trust the resource ID alone — always scope by the authenticated user. This prevents IDOR (Insecure Direct Object Reference) vulnerabilities.

---

## Shared token table

Admin and user sessions share the same `refresh_tokens` table, distinguished by `entity_type`:

| Entity type | Cookie path | Scopes |
|-------------|-------------|--------|
| `"admin"` | `/api/admin/auth` | `["admin"]`, `["admin", "superadmin"]` |
| `"user"` | `/api/auth` | `["user"]` |

This means a single `DELETE FROM refresh_tokens WHERE entity_type = 'user' AND entity_id = ?` revokes all of a user's sessions across all devices.

---

## Module structure

A typical user-facing module follows this pattern:

```go
package userbookmarks

import (
    "github.com/stanza-go/framework/pkg/auth"
    "github.com/stanza-go/framework/pkg/http"
    "github.com/stanza-go/framework/pkg/sqlite"
)

type Module struct {
    db *sqlite.DB
}

// Register mounts routes on the user group (already protected by auth middleware).
func Register(group *http.Group, db *sqlite.DB) {
    m := &Module{db: db}
    group.Get("/bookmarks", m.listHandler)
    group.Post("/bookmarks", m.createHandler)
    group.Get("/bookmarks/{id}", m.getHandler)
    group.Put("/bookmarks/{id}", m.updateHandler)
    group.Delete("/bookmarks/{id}", m.deleteHandler)
}

func (m *Module) listHandler(w http.ResponseWriter, r *http.Request) {
    claims, ok := auth.ClaimsFromContext(r.Context())
    if !ok {
        http.WriteError(w, http.StatusUnauthorized, "authentication required")
        return
    }

    q := sqlite.Select("id", "url", "title", "created_at").
        From("bookmarks").
        Where("user_id = ?", claims.UID)

    // Add search filter if provided
    if search := r.URL.Query().Get("q"); search != "" {
        q.WhereSearch(search, "title", "url")
    }

    q.OrderBy("created_at", "DESC")
    q.Paginate(http.QueryParamPage(r))

    // ... query and respond
}
```

The key structural point: the module's `Register` function takes a `*http.Group` that already has auth middleware applied. The module itself never checks tokens — it only reads `claims.UID` from the context.

---

## Tips

- **Same error for wrong email and wrong password.** Return `"invalid email or password"` in both cases to prevent email enumeration.
- **Auto-login after registration.** Don't redirect users to a login page after they register. Call the same `issueSession` helper that login uses.
- **Revoke sessions on password change.** When a user changes their password, delete all their refresh tokens except the current one. This forces other devices to re-authenticate.
- **Revoke sessions on deactivation.** When an admin deactivates a user, delete all their refresh tokens immediately. The status endpoint also checks `is_active` as a safety net.
- **API key fallback.** The `RequireAuthOrAPIKey` middleware accepts both JWT cookies and Bearer tokens. Users can create API keys for programmatic access — the handler sees the same `claims.UID` regardless of auth method.
