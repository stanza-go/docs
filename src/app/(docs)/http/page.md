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

For integer path parameters, `PathParamInt64` parses the value and writes a 400 error if invalid:

```go
router.HandleFunc("GET /api/users/{id}", func(w http.ResponseWriter, r *http.Request) {
    id, ok := http.PathParamInt64(w, r, "id")
    if !ok {
        return // 400 response already written
    }
    // id is int64
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

## CSV export

Write CSV file responses with automatic Content-Type and Content-Disposition headers:

```go
rows, err := db.Query(sql, args...)
if err != nil {
    http.WriteError(w, http.StatusInternalServerError, "failed to export")
    return
}
defer rows.Close()

http.WriteCSV(w, "users", []string{"ID", "Email", "Name"}, func() []string {
    if !rows.Next() {
        return nil
    }
    var id int64
    var email, name string
    if err := rows.Scan(&id, &email, &name); err != nil {
        return nil
    }
    return []string{strconv.FormatInt(id, 10), email, name}
})
```

The `entity` parameter controls the filename: `users` produces `users-20260322.csv`. The callback is called repeatedly until it returns nil.

---

## Bulk ID validation

Validate ID slices for bulk operations (bulk delete, bulk update):

```go
var req struct {
    IDs []int64 `json:"ids"`
}
if err := http.ReadJSON(r, &req); err != nil {
    http.WriteError(w, http.StatusBadRequest, "invalid request body")
    return
}
if !http.CheckBulkIDs(w, req.IDs, 100) {
    return // 400 response already written
}
```

`CheckBulkIDs` writes a 400 error and returns false if the slice is empty or exceeds the maximum count.

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
router.Use(http.Compress(http.CompressConfig{}))           // 3. gzip compression
router.Use(http.ETag(http.ETagConfig{}))                   // 4. conditional requests
router.Use(http.SecureHeaders(http.SecureHeadersConfig{})) // 5. security headers
router.Use(http.MaxBody(2 << 20))                          // 6. request body limit (2 MB)
router.Use(http.CORS(corsConfig))                          // 7. CORS
router.Use(http.Recovery(onPanic))                         // 8. panic recovery
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

`RequestLogger` also stores a request-scoped child logger (with `request_id` pre-set) in the request context. Handlers retrieve it with `log.FromContext` so that every log entry from a handler is correlated with the HTTP request:

```go
func myHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        l := log.FromContext(r.Context())
        // l.Error(...) automatically includes request_id
    }
}
```

**Compression** — gzip-compresses responses to reduce transfer size:

```go
router.Use(http.Compress(http.CompressConfig{}))
```

Buffers the response body until it exceeds a minimum size threshold (default 1 KB), then checks the `Content-Type` to decide whether to compress. Only text-based content types are compressed — binary formats like images, video, and archives are already compressed and gain nothing from gzip.

The client must advertise `Accept-Encoding: gzip` for compression to activate. When active, the middleware sets `Content-Encoding: gzip` and `Vary: Accept-Encoding`, and removes `Content-Length` since the final size is unknown until gzip finishes.

Uses `sync.Pool` to reuse gzip writers — zero allocations in steady state.

Configuration:

| Field | Default | Description |
|-------|---------|-------------|
| `Level` | `6` (default compression) | Gzip level 1–9. Higher = smaller output, more CPU |
| `MinSize` | `1024` | Minimum body size in bytes before compressing |
| `ContentTypes` | See below | MIME type prefixes eligible for compression |

Default content types compressed:

- `text/*` (HTML, CSS, plain text)
- `application/json`
- `application/javascript`
- `application/xml`
- `application/xhtml+xml`
- `image/svg+xml`

Custom configuration example:

```go
router.Use(http.Compress(http.CompressConfig{
    Level:   gzip.BestSpeed,       // level 1 — fastest
    MinSize: 512,                  // compress responses > 512 bytes
    ContentTypes: []string{        // only compress JSON
        "application/json",
    },
}))
```

**ETag** — enables conditional requests with `304 Not Modified`:

```go
router.Use(http.ETag(http.ETagConfig{}))
```

Computes a CRC32 hash of the response body and sets it as the `ETag` header. When a client sends `If-None-Match` with a matching ETag, the middleware returns `304 Not Modified` with no body, saving bandwidth.

Only applies to `GET` and `HEAD` requests with `2xx` responses that have a body. Responses that already carry an `ETag` header (e.g., from `net/http`'s file server) are passed through unchanged.

Configuration:

| Field | Default | Description |
|-------|---------|-------------|
| `Weak` | `false` | Produce weak ETags (`W/"..."`) instead of strong ETags |

Weak ETags indicate semantic equivalence rather than byte-for-byte identity. Use them when responses may vary slightly (e.g., different whitespace) but are logically the same:

```go
router.Use(http.ETag(http.ETagConfig{Weak: true}))
```

ETag matching follows RFC 7232 §3.2 — weak comparison is used for `If-None-Match`, so `W/"abc"` matches `"abc"`. Comma-separated lists and the `*` wildcard are supported.

**Chain position:** ETag should be placed after Compress so the hash is computed on uncompressed content. This ensures the ETag remains stable regardless of whether the client accepts gzip.

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
    AllowOrigins:     []string{"http://localhost:23706", "http://localhost:23700"},
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

**Request body limit** — caps how much data handlers can read:

```go
router.Use(http.MaxBody(2 << 20)) // 2 MB
```

Wraps request bodies with `MaxBytesReader`. When a handler reads beyond the limit, the read returns an error and the server closes the connection. This protects JSON and form endpoints from abuse without affecting file uploads.

Multipart requests (`Content-Type: multipart/*`) are exempt — upload handlers should enforce their own limits directly. This lets you set a tight global limit (e.g., 2 MB) while allowing specific upload endpoints to accept larger payloads (e.g., 50 MB).

When the limit is exceeded, `ReadJSON` returns `ErrBodyTooLarge` which is automatically translated to a `400 Bad Request` response.

**Chain position:** Place after `SecureHeaders` and before `CORS`. This ensures security headers are always set, even on oversized requests.

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

## Pagination

`ParsePagination` extracts `limit` and `offset` query parameters from the request with validation and clamping:

```go
// Parse with default limit 50, max limit 100
pg := http.ParsePagination(r, 50, 100)

// Use with query builder
sql, args := sqlite.Select("id", "name", "email").
    From("users").
    Limit(pg.Limit).
    Offset(pg.Offset).
    Build()
```

The limit is clamped between 1 and `maxLimit`. The offset is clamped to non-negative. Invalid or missing values fall back to the defaults.

### Paginated response

`PaginatedResponse` writes a standardized JSON response with items and total count:

```go
http.PaginatedResponse(w, "users", users, total)
// Response: {"users": [...], "total": 42}
```

The items are written under the given key. For endpoints that need additional fields (e.g., unread counts), use `ParsePagination` for input and write the response manually with `WriteJSON`.

### Full example

```go
func listHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        pg := http.ParsePagination(r, 50, 100)

        selectQ := sqlite.Select("id", "name", "email").
            From("users").
            WhereNull("deleted_at").
            Limit(pg.Limit).
            Offset(pg.Offset)

        countQ := sqlite.CountFrom(selectQ)

        // ... execute queries, scan rows ...

        http.PaginatedResponse(w, "users", users, total)
    }
}
```

---

## Sorting

`QueryParamSort` reads `sort` and `order` query parameters and validates them against a whitelist of allowed columns:

```go
col, dir := http.QueryParamSort(r,
    []string{"id", "email", "name", "created_at"},
    "id", "DESC",  // defaults
)

selectQ.OrderBy(col, dir)
```

- The `sort` parameter is matched case-insensitively against the allowed list
- The `order` parameter accepts `"asc"` or `"desc"` (case-insensitive), normalized to uppercase
- If `sort` is missing or not in the allowed list, the default column is used
- If `order` is invalid, the default direction is used

This prevents SQL injection by only allowing pre-approved column names.

### Combined with pagination

```go
func listHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        pg := http.ParsePagination(r, 50, 100)
        col, dir := http.QueryParamSort(r,
            []string{"id", "email", "name", "created_at"},
            "id", "DESC",
        )

        selectQ := sqlite.Select("id", "name", "email", "created_at").
            From("users").
            WhereNull("deleted_at").
            OrderBy(col, dir).
            Limit(pg.Limit).
            Offset(pg.Offset)

        countQ := sqlite.CountFrom(selectQ)

        // ... execute and respond ...
    }
}
```

The client requests: `GET /api/admin/users?sort=name&order=asc&limit=20&offset=40`

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

## Request metrics

Track request counts, status code distribution, and average latency with `Metrics`:

```go
m := http.NewMetrics()
router.Use(m.Middleware())

// In a handler (e.g. dashboard):
stats := m.Stats()
```

Add the middleware early in the chain — after `RequestID` but before `RequestLogger` — so it captures the full request lifecycle.

`Stats()` returns a `MetricsStats` snapshot:

| Field | Type | Description |
|-------|------|-------------|
| `TotalRequests` | `int64` | Cumulative requests processed |
| `ActiveRequests` | `int64` | Currently in-flight requests |
| `Status2xx` | `int64` | Successful responses |
| `Status3xx` | `int64` | Redirects |
| `Status4xx` | `int64` | Client errors |
| `Status5xx` | `int64` | Server errors |
| `BytesWritten` | `int64` | Total response bytes |
| `AvgDurationMs` | `float64` | Mean request duration (ms) |

All counters are atomic — safe to read from any goroutine without synchronization.

---

## Prometheus metrics

`PrometheusHandler` returns a handler that renders metrics in [Prometheus text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format). Pass a collector function that gathers metrics on each scrape:

```go
router.HandleFunc("GET /metrics", http.PrometheusHandler(func() []http.PrometheusMetric {
    dbStats := db.Stats()
    httpStats := metrics.Stats()
    return []http.PrometheusMetric{
        {Name: "myapp_db_reads_total", Help: "Total read queries", Type: "counter", Value: float64(dbStats.TotalReads)},
        {Name: "myapp_db_writes_total", Help: "Total write queries", Type: "counter", Value: float64(dbStats.TotalWrites)},
        {Name: "myapp_http_requests_total", Help: "Total HTTP requests", Type: "counter", Value: float64(httpStats.TotalRequests)},
        {Name: "myapp_http_requests_active", Help: "In-flight requests", Type: "gauge", Value: float64(httpStats.ActiveRequests)},
    }
}))
```

Each `PrometheusMetric` has four fields:

| Field | Type | Description |
|-------|------|-------------|
| `Name` | `string` | Metric name (e.g. `myapp_http_requests_total`) |
| `Help` | `string` | One-line description |
| `Type` | `string` | `"counter"` (monotonically increasing) or `"gauge"` (point-in-time) |
| `Value` | `float64` | Current value |

The handler sets `Content-Type: text/plain; version=0.0.4` as required by the Prometheus scrape protocol. See the [observability recipe](/docs/recipes/observability) for a complete example wiring all framework Stats() into a single `/api/metrics` endpoint.

---

## Status codes

The package re-exports common HTTP status codes as constants:

| Constant | Value |
|----------|-------|
| `StatusOK` | 200 |
| `StatusCreated` | 201 |
| `StatusNoContent` | 204 |
| `StatusNotModified` | 304 |
| `StatusBadRequest` | 400 |
| `StatusUnauthorized` | 401 |
| `StatusForbidden` | 403 |
| `StatusNotFound` | 404 |
| `StatusMethodNotAllowed` | 405 |
| `StatusConflict` | 409 |
| `StatusRequestEntityTooLarge` | 413 |
| `StatusUnprocessableEntity` | 422 |
| `StatusTooManyRequests` | 429 |
| `StatusInternalServerError` | 500 |
| `StatusServiceUnavailable` | 503 |

---

## WebSocket

The `pkg/http` package includes a zero-dependency RFC 6455 WebSocket implementation for building real-time features.

### Upgrading a connection

Use `Upgrader` to upgrade an HTTP connection to WebSocket:

```go
upgrader := http.Upgrader{}

func wsHandler(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r)
    if err != nil {
        return // Upgrade writes the error response
    }
    defer conn.Close()

    for {
        msgType, data, err := conn.ReadMessage()
        if err != nil {
            break // Client disconnected or error
        }
        // Echo back
        conn.WriteMessage(msgType, data)
    }
}
```

The upgrader validates the handshake (method, headers, `Sec-WebSocket-Key`) and writes the `101 Switching Protocols` response. By default, it checks that the `Origin` header matches the `Host` header. Non-browser clients that omit `Origin` are allowed.

### Upgrader configuration

| Field | Default | Description |
|-------|---------|-------------|
| `ReadBufferSize` | 4096 | Read buffer size in bytes |
| `WriteBufferSize` | 4096 | Write buffer size in bytes |
| `CheckOrigin` | Origin == Host | Function to validate the request origin |

```go
upgrader := http.Upgrader{
    ReadBufferSize:  8192,
    WriteBufferSize: 8192,
    CheckOrigin: func(r *http.Request) bool {
        return true // Allow all origins
    },
}
```

### Message types

| Constant | Value | Description |
|----------|-------|-------------|
| `TextMessage` | 1 | UTF-8 text data |
| `BinaryMessage` | 2 | Binary data |

```go
// Send a JSON message
data, _ := json.Marshal(map[string]string{"status": "ok"})
conn.WriteMessage(http.TextMessage, data)

// Read a message
msgType, payload, err := conn.ReadMessage()
if msgType == http.TextMessage {
    // Handle text
}
```

### Control frames

Ping/pong frames are handled automatically — incoming pings are replied with pongs. You can also send them explicitly:

```go
conn.WritePing([]byte("heartbeat"))
conn.WritePong([]byte("heartbeat"))
```

Custom handlers:

```go
conn.SetPingHandler(func(data []byte) error {
    fmt.Println("ping received:", string(data))
    return conn.WritePong(data)
})
```

### Connection settings

```go
// Max incoming message size (default: 16 MB)
conn.SetMaxMessageSize(1 << 20) // 1 MB

// Timeouts
conn.SetReadDeadline(time.Now().Add(60 * time.Second))
conn.SetWriteDeadline(time.Now().Add(10 * time.Second))

// Peer address
addr := conn.RemoteAddr()
```

### Closing

```go
// Simple close
conn.Close()

// Close with status code and message
conn.CloseWithMessage(http.CloseNormalClosure, "goodbye")
```

| Constant | Code | Description |
|----------|------|-------------|
| `CloseNormalClosure` | 1000 | Normal closure |
| `CloseGoingAway` | 1001 | Server shutting down |
| `CloseProtocolError` | 1002 | Protocol error |
| `CloseUnsupportedData` | 1003 | Unsupported data type |
| `CloseNoStatusReceived` | 1005 | No close code in frame (not sent by application) |
| `CloseAbnormalClosure` | 1006 | Connection dropped without close frame (not sent by application) |
| `CloseInvalidPayload` | 1007 | Invalid UTF-8 in text message |
| `ClosePolicyViolation` | 1008 | Message violates server policy |
| `CloseMessageTooBig` | 1009 | Message exceeds size limit |

When the peer sends a close frame, `ReadMessage` returns a `*CloseError` with the code and text:

```go
_, _, err := conn.ReadMessage()
if err != nil {
    var closeErr *http.CloseError
    if errors.As(err, &closeErr) {
        fmt.Printf("closed with code %d: %s\n", closeErr.Code, closeErr.Text)
    }
}
```

### Middleware compatibility

WebSocket connections work through the middleware stack. Each middleware wrapper (`responseRecorder`, `compressWriter`, `etagWriter`) implements `Unwrap() ResponseWriter`, allowing the upgrader to find the underlying `net/http.Hijacker` interface automatically. No special middleware ordering is needed.

### Concurrency model

One reader goroutine and one writer goroutine can operate on the same `Conn` concurrently. All writes (including control frames) are protected by a mutex. A typical pattern:

```go
conn, _ := upgrader.Upgrade(w, r)
defer conn.Close()

done := make(chan struct{})

// Reader goroutine — detects disconnection
go func() {
    defer close(done)
    for {
        _, _, err := conn.ReadMessage()
        if err != nil {
            return
        }
    }
}()

// Writer — sends events until client disconnects
ticker := time.NewTicker(30 * time.Second)
defer ticker.Stop()

for {
    select {
    case <-done:
        return
    case event := <-events:
        data, _ := json.Marshal(event)
        conn.WriteMessage(http.TextMessage, data)
    case <-ticker.C:
        conn.WritePing(nil)
    }
}
```
