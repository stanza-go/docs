---
title: Authentication
nextjs:
  metadata:
    title: Authentication
    description: JWT tokens, password hashing, cookie management, API key auth, and middleware.
---

The `pkg/auth` package provides a complete authentication system: JWT access tokens, refresh tokens, password hashing, cookie management, API key authentication, and middleware.

```go
import "github.com/stanza-go/framework/pkg/auth"
```

---

## Overview

Stanza uses a hybrid stateless JWT strategy:

- **Access token (JWT):** 5-minute lifetime, stored in `HttpOnly` cookie. Contains `uid` and `scopes`. Zero DB lookup on every request.
- **Refresh token (opaque):** 24-hour lifetime, stored in a separate `HttpOnly` cookie scoped to auth endpoints. Hashed server-side.
- **Status polling:** Frontend polls every ~60 seconds to refresh the access token and check revocation.
- **API keys:** For programmatic access via `Authorization: Bearer` header.

---

## Creating an auth instance

```go
key := make([]byte, 32) // minimum 32 bytes
// ... load from config or generate

a := auth.New(key,
    auth.WithAccessTokenTTL(5 * time.Minute),   // default: 5m
    auth.WithRefreshTokenTTL(24 * time.Hour),    // default: 24h
    auth.WithCookiePath("/api/admin"),            // default: "/api/admin"
    auth.WithSecureCookies(true),                 // default: true
)
```

A Stanza app typically has two auth instances — one for admins (cookie path `/api/admin`) and one for users (cookie path `/api`). Both share the same signing key.

---

## JWT tokens

### Issue an access token

```go
token, err := a.IssueAccessToken("user-123", []string{"admin", "write"})
```

The token is a signed JWT containing the user ID, scopes, issued-at, and expiration time.

### Validate a token

```go
claims, err := a.ValidateAccessToken(token)
if err == auth.ErrTokenExpired {
    // token expired — client should refresh
}
if err == auth.ErrInvalidToken {
    // bad signature or malformed
}

// Use claims
fmt.Println(claims.UID)    // "user-123"
fmt.Println(claims.Scopes) // ["admin", "write"]
```

### Low-level JWT functions

For advanced use cases, the raw JWT functions are available:

```go
token, err := auth.CreateJWT(key, auth.Claims{
    UID:       "user-123",
    Scopes:    []string{"admin"},
    IssuedAt:  time.Now().Unix(),
    ExpiresAt: time.Now().Add(5 * time.Minute).Unix(),
})

claims, err := auth.ValidateJWT(key, token)
```

---

## Password hashing

Hash and verify passwords with PBKDF2-HMAC-SHA256 (100,000 iterations):

```go
// Hash a password for storage
hash, err := auth.HashPassword("my-secret-password")
// hash = "pbkdf2$100000$<salt_hex>$<hash_hex>"

// Verify a password against a stored hash
if auth.VerifyPassword(hash, "my-secret-password") {
    // correct
}
```

---

## Refresh tokens

Generate and hash opaque refresh tokens:

```go
// Generate a random 64-character hex token
token, err := auth.GenerateRefreshToken()

// Hash for database storage (SHA-256)
hash := auth.HashToken(token)
// Store `hash` in the refresh_tokens table, send `token` to client
```

---

## Cookie management

Set and clear auth cookies on HTTP responses:

```go
// Set cookies after successful login
a.SetAccessTokenCookie(w, accessToken)
a.SetRefreshTokenCookie(w, refreshToken)

// Clear cookies on logout
a.ClearAllCookies(w)
```

Read tokens from incoming requests:

```go
accessToken, err := auth.ReadAccessToken(r)
refreshToken, err := auth.ReadRefreshToken(r)
```

Cookie properties: `HttpOnly`, `SameSite=Lax`, `Secure` (configurable). The refresh token cookie is scoped to the auth endpoint path only.

---

## Middleware

### RequireAuth

Validates the JWT from the access token cookie. Returns 401 if missing, expired, or invalid. Stores claims in the request context:

```go
admin := router.Group("/api/admin")
admin.Use(a.RequireAuth())

admin.HandleFunc("GET /dashboard", func(w http.ResponseWriter, r *http.Request) {
    claims, _ := auth.ClaimsFromContext(r.Context())
    fmt.Println(claims.UID) // the authenticated user
})
```

### RequireScope

Checks that the authenticated user has a specific scope. Returns 403 if missing. Must be used after `RequireAuth`:

```go
admin.Use(a.RequireAuth())
admin.Use(auth.RequireScope("admin"))
```

### RequireAPIKey

Validates API keys from the `Authorization: Bearer` header. The key is hashed with SHA-256 and passed to a validator function that looks it up in the database:

```go
type KeyValidator func(keyHash string) (Claims, error)

// In your module:
func NewValidator(db *sqlite.DB) auth.KeyValidator {
    return func(keyHash string) (auth.Claims, error) {
        // Query api_keys table by key_hash
        // Check revoked_at and expires_at
        // Return claims with UID and scopes
    }
}

// Wire it up:
v1 := router.Group("/api/v1")
v1.Use(auth.RequireAPIKey(validator))
```

### RequireAuthOrAPIKey

Tries JWT cookie first, falls back to API key:

```go
v1.Use(a.RequireAuthOrAPIKey(validator))
```

---

## Claims

The `Claims` struct carries authentication data through the request:

```go
type Claims struct {
    UID       string   // user identifier
    Scopes    []string // permission scopes
    IssuedAt  int64    // Unix timestamp
    ExpiresAt int64    // Unix timestamp
}

// Check if claims are still valid
claims.Valid()

// Check for a specific scope
claims.HasScope("admin")
```

Extract claims from request context (set by middleware):

```go
claims, ok := auth.ClaimsFromContext(r.Context())
if !ok {
    // not authenticated
}
```

---

## Errors

| Error | When |
|-------|------|
| `auth.ErrInvalidToken` | Malformed JWT, bad signature, decode failure |
| `auth.ErrTokenExpired` | JWT `exp` claim is in the past |
| `auth.ErrNoToken` | No cookie or Authorization header found |
