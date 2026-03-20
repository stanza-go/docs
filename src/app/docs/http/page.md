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

### Built-in middleware

**Request logging** — logs method, path, status, duration, and response size:

```go
router.Use(http.RequestLogger(logger))
```

5xx responses are logged at Error level, everything else at Info.

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
