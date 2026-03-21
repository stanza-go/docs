---
title: HTTP routing
nextjs:
  metadata:
    title: HTTP routing
    description: Router, middleware, route groups, request/response utilities, and server management.
---

The `pkg/http` package provides HTTP routing, middleware, request/response handling, and server lifecycle management. It wraps Go's standard `net/http` with a clean API for building JSON APIs and serving SPAs.

```go
import "github.com/stanza-go/framework/pkg/http"
```

---

## Router

Create a router and register handlers using Go 1.22+ pattern syntax:

```go
router := http.NewRouter()

router.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
    http.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
})

router.HandleFunc("POST /api/users", createUser)
router.HandleFunc("GET /api/users/{id}", getUser)
router.HandleFunc("DELETE /api/users/{id}", deleteUser)
```

---

## Path parameters

Extract path parameters with `http.PathParam`:

```go
router.HandleFunc("GET /api/users/{id}", func(w http.ResponseWriter, r *http.Request) {
    id := http.PathParam(r, "id")
    // ...
})
```

---

## Query parameters

```go
// Simple string parameter
name := http.QueryParam(r, "name")

// With fallback value
sort := http.QueryParamOr(r, "sort", "created_at")

// Integer with fallback
page := http.QueryParamInt(r, "page", 1)
perPage := http.QueryParamInt(r, "per_page", 20)
```

---

## Reading request bodies

Parse JSON request bodies with automatic size limiting:

```go
var input struct {
    Name  string `json:"name"`
    Email string `json:"email"`
}

if err := http.ReadJSON(r, &input); err != nil {
    http.WriteError(w, http.StatusBadRequest, "invalid JSON")
    return
}
```

The default body limit is 1MB. For larger payloads:

```go
// Allow up to 10MB
if err := http.ReadJSONLimit(r, &input, 10<<20); err != nil {
    http.WriteError(w, http.StatusBadRequest, "invalid JSON")
    return
}
```

---

## Writing responses

```go
// JSON response with status code
http.WriteJSON(w, http.StatusOK, map[string]any{
    "user": user,
    "total": count,
})

// Created response
http.WriteJSON(w, http.StatusCreated, user)

// Error response — writes {"error": "message"}
http.WriteError(w, http.StatusNotFound, "user not found")
http.WriteError(w, http.StatusUnauthorized, "invalid credentials")
```

---

## Route groups

Groups share a path prefix and middleware. They can be nested:

```go
api := router.Group("/api")

// Public endpoints
api.HandleFunc("GET /health", healthHandler)

// Protected admin group
admin := api.Group("/admin")
admin.Use(auth.RequireAuth())
admin.Use(auth.RequireScope("admin"))
admin.HandleFunc("GET /dashboard", dashboardHandler)
admin.HandleFunc("GET /users", listUsersHandler)
admin.HandleFunc("POST /users", createUserHandler)

// Protected user group
user := api.Group("/user")
user.Use(auth.RequireAuth())
user.Use(auth.RequireScope("user"))
user.HandleFunc("GET /profile", profileHandler)
```

Middleware applied to a group runs for all handlers in that group and its sub-groups, after any router-level middleware.

---

## Middleware

Middleware wraps handlers to add behavior. The type signature is:

```go
type Middleware func(Handler) Handler
```

Apply middleware to the router (global) or to groups:

```go
// Global middleware — runs for every request
router.Use(http.RequestLogger(logger))
router.Use(http.CORS(corsConfig))
router.Use(http.Recovery(onPanic))

// Group middleware — runs for routes in the group
admin.Use(auth.RequireAuth())
```

### Recommended middleware order

The middleware chain should be ordered so that each middleware can access context set by earlier ones:

```go
router.Use(http.RequestID(http.RequestIDConfig{}))        // 1. assign request ID
router.Use(http.RequestLogger(logger))                     // 2. log with request ID
router.Use(http.SecureHeaders(http.SecureHeadersConfig{})) // 3. security headers
router.Use(http.CORS(corsConfig))                          // 4. CORS
router.Use(http.Recovery(onPanic))                         // 5. panic recovery
```

### Built-in middleware

**Request ID** — assigns a unique identifier to every request:

```go
router.Use(http.RequestID(http.RequestIDConfig{}))
```

Generates a UUID v4 per request and sets it as the `X-Request-ID` response header. If the incoming request already carries `X-Request-ID`, that value is reused (for distributed tracing with upstream proxies).

Access the ID in handlers:

```go
id := http.GetRequestID(r)
```

Configuration:

| Field | Default | Description |
|-------|---------|-------------|
| `Header` | `X-Request-ID` | Header name to read/write |
| `Generator` | UUID v4 | Custom ID generator function |

```go
router.Use(http.RequestID(http.RequestIDConfig{
    Header:    "X-Trace-ID",
    Generator: func() string { return myCustomID() },
}))
```

**Request logging** — logs method, path, status, duration, and response size:

```go
router.Use(http.RequestLogger(logger))
```

5xx responses are logged at Error level, everything else at Info. When `RequestID` middleware runs earlier in the chain, the `request_id` field is automatically included in each log entry.

**Security headers** — sets common security headers on all responses:

```go
router.Use(http.SecureHeaders(http.SecureHeadersConfig{}))
```

With zero-value config, it applies safe defaults:

| Header | Default Value |
|--------|---------------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-XSS-Protection` | `0` (disabled — CSP replaces it) |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

Optional headers enabled via config:

```go
router.Use(http.SecureHeaders(http.SecureHeadersConfig{
    HSTSMaxAge:            63072000,                      // 2 years, HTTPS only
    ContentSecurityPolicy: "default-src 'self'",          // app-specific CSP
    FrameOptions:          "SAMEORIGIN",                  // allow same-origin framing
}))
```

**CORS** — handles cross-origin requests and preflight:

```go
router.Use(http.CORS(http.CORSConfig{
    AllowOrigins:     []string{"http://localhost:23705", "http://localhost:23700"},
    AllowCredentials: true,
    MaxAge:           86400,
}))
```

Default allowed methods: GET, POST, PUT, DELETE, PATCH, OPTIONS. Default allowed headers: Origin, Content-Type, Accept, Authorization.

**Recovery** — catches panics and returns 500:

```go
router.Use(http.Recovery(func(recovered any, stack []byte) {
    logger.Error("panic", log.Any("error", recovered), log.String("stack", string(stack)))
}))
```

The callback is optional — pass `nil` to recover silently.

---

## Rate limiting

The `RateLimit` middleware limits requests per key (default: client IP) using a fixed-window counter:

```go
authGroup.Use(http.RateLimit(http.RateLimitConfig{
    Limit:  20,
    Window: time.Minute,
}))
```

When the limit is exceeded, it returns `429 Too Many Requests` with a `Retry-After` header.

### Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `Limit` | `60` | Max requests per window |
| `Window` | `1 minute` | Time window duration |
| `KeyFunc` | Client IP | Function to extract the rate limit key |
| `Message` | `"rate limit exceeded"` | Error message in 429 response |

### Response headers

Every response includes rate limit headers:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Configured limit |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when the window expires |
| `Retry-After` | Seconds until retry (only on 429) |

### Custom key function

Rate limit by API key instead of IP:

```go
router.Use(http.RateLimit(http.RateLimitConfig{
    Limit:   100,
    Window:  time.Minute,
    KeyFunc: func(r *http.Request) string { return r.Header.Get("X-API-Key") },
}))
```

### Client IP extraction

The `ClientIP` helper (used by default) extracts the real client IP behind proxies:

```go
ip := http.ClientIP(r)  // checks X-Forwarded-For, X-Real-IP, then RemoteAddr
```

### Group-level rate limiting

Apply rate limits to specific route groups (e.g., auth endpoints):

```go
// Rate limit auth endpoints at 20 req/min per IP
authGroup := api.Group("")
authGroup.Use(http.RateLimit(http.RateLimitConfig{
    Limit:  20,
    Window: time.Minute,
}))
authGroup.HandleFunc("POST /auth/login", loginHandler)
authGroup.HandleFunc("POST /auth/register", registerHandler)
authGroup.HandleFunc("POST /auth/forgot-password", forgotHandler)
```

---

## Static file serving

Serve embedded SPAs with client-side routing support:

```go
//go:embed ui/dist
var uiFS embed.FS

//go:embed admin/dist
var adminFS embed.FS

router.Handle("GET /admin/{path...}", http.Static(adminFS))
router.Handle("GET /{path...}", http.Static(uiFS))
```

Static serves files that exist in the filesystem. For paths without an extension that don't match a file, it serves `index.html` (SPA fallback). Paths with an extension that don't match return 404.

---

## Server

Wrap the router in a server with lifecycle management:

```go
srv := http.NewServer(router,
    http.WithAddr(":23710"),
    http.WithReadTimeout(15 * time.Second),
    http.WithWriteTimeout(15 * time.Second),
    http.WithIdleTimeout(60 * time.Second),
)

// Start serving (non-blocking)
srv.Start(ctx)

// Graceful shutdown
srv.Stop(ctx)
```

In a Stanza app, the server is wired through the lifecycle:

```go
func provideServer(lc *lifecycle.Lifecycle, router *http.Router) *http.Server {
    srv := http.NewServer(router, http.WithAddr(":23710"))

    lc.Append(lifecycle.Hook{
        OnStart: srv.Start,
        OnStop:  srv.Stop,
    })

    return srv
}
```

---

## Status codes

The package re-exports common HTTP status codes as constants:

| Constant | Value |
|----------|-------|
| `StatusOK` | 200 |
| `StatusCreated` | 201 |
| `StatusNoContent` | 204 |
| `StatusBadRequest` | 400 |
| `StatusUnauthorized` | 401 |
| `StatusForbidden` | 403 |
| `StatusNotFound` | 404 |
| `StatusConflict` | 409 |
| `StatusUnprocessableEntity` | 422 |
| `StatusTooManyRequests` | 429 |
| `StatusInternalServerError` | 500 |
| `StatusServiceUnavailable` | 503 |
