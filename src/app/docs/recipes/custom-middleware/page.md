---
title: Building custom middleware
nextjs:
  metadata:
    title: Building custom middleware
    description: How to write custom middleware for the Stanza HTTP framework — from simple header injection to stateful rate limiting.
---

This recipe covers how to write custom middleware for `pkg/http`. You'll learn the middleware signature, common patterns (before/after, context injection, gate-keeping, response wrapping), and how to wire middleware into your app.

---

## Middleware signature

Every middleware in Stanza has the same type:

```go
type Middleware func(Handler) Handler
```

A middleware receives the next handler in the chain and returns a new handler that wraps it. The wrapper can run code before calling `next`, after calling `next`, or both. It can also skip calling `next` entirely to short-circuit the request.

---

## Pattern 1: Before the handler

The simplest middleware runs code before the handler — setting headers, modifying the request, or logging.

```go
func TimingHeader() http.Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("X-Request-Start", strconv.FormatInt(time.Now().UnixMilli(), 10))
            next.ServeHTTP(w, r)
        })
    }
}
```

This is the pattern used by `SecureHeaders` (sets security headers) and `MaxBody` (limits request body size).

---

## Pattern 2: Context injection

Pass data to downstream handlers by adding values to the request context:

```go
type contextKey struct{}

func TenantFromHeader() http.Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            tenant := r.Header.Get("X-Tenant-ID")
            if tenant == "" {
                http.WriteError(w, http.StatusBadRequest, "missing X-Tenant-ID header")
                return
            }

            ctx := context.WithValue(r.Context(), contextKey{}, tenant)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// GetTenant retrieves the tenant ID set by TenantFromHeader middleware.
func GetTenant(r *http.Request) string {
    v, _ := r.Context().Value(contextKey{}).(string)
    return v
}
```

This is the pattern used by `RequestID` (stores the request ID in context) and `auth.RequireAuth` (stores JWT claims in context).

{% callout title="Context key types" %}
Always use an unexported struct type as the context key. String keys risk collisions across packages.
{% /callout %}

---

## Pattern 3: Gate-keeping

A gate-keeping middleware validates a condition and either allows the request through or returns an error immediately — never calling `next`:

```go
func RequireAPIKey(validKeys map[string]bool) http.Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            key := r.Header.Get("X-API-Key")
            if key == "" || !validKeys[key] {
                http.WriteError(w, http.StatusUnauthorized, "invalid API key")
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

This is the pattern used by `auth.RequireAuth` (validates JWT) and `auth.RequireScope` (checks scope claims). The key rule: **return early without calling `next.ServeHTTP`** when the condition fails.

---

## Pattern 4: After the handler

To inspect the response (status code, body size, duration), you need to wrap the `ResponseWriter`:

```go
type statusRecorder struct {
    http.ResponseWriter
    status int
}

func (sr *statusRecorder) WriteHeader(code int) {
    sr.status = code
    sr.ResponseWriter.WriteHeader(code)
}

func (sr *statusRecorder) Unwrap() http.ResponseWriter {
    return sr.ResponseWriter
}

func LogSlowRequests(logger *log.Logger, threshold time.Duration) http.Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()

            rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
            next.ServeHTTP(rec, r)

            elapsed := time.Since(start)
            if elapsed > threshold {
                logger.Warn("slow request",
                    log.String("method", r.Method),
                    log.String("path", r.URL.Path),
                    log.Int("status", rec.status),
                    log.Duration("duration", elapsed),
                )
            }
        })
    }
}
```

This is the pattern used by `RequestLogger` — it wraps the writer to capture status and byte count, then logs after the handler finishes.

{% callout title="Unwrap method" %}
Always implement `Unwrap() http.ResponseWriter` on your wrapper. Other middleware in the chain (like `Compress`) may need to find the original writer — for example, WebSocket upgrades call `Hijack()` on the underlying connection.
{% /callout %}

---

## Pattern 5: Configurable middleware

For middleware with options, use a config struct:

```go
type MaintenanceConfig struct {
    // Enabled controls whether maintenance mode is active.
    Enabled func() bool
    // Message is the error message returned during maintenance.
    Message string
    // AllowedIPs are exempt from maintenance mode.
    AllowedIPs []string
}

func Maintenance(cfg MaintenanceConfig) http.Middleware {
    if cfg.Message == "" {
        cfg.Message = "service temporarily unavailable"
    }

    // Pre-compute the allowed set once (not per request).
    allowed := make(map[string]bool, len(cfg.AllowedIPs))
    for _, ip := range cfg.AllowedIPs {
        allowed[ip] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if cfg.Enabled() && !allowed[r.RemoteAddr] {
                http.WriteError(w, http.StatusServiceUnavailable, cfg.Message)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

Pre-compute expensive operations (string joins, map builds, regex compilation) in the outer function, not inside the handler. The handler runs on every request — the outer function runs once.

---

## Pattern 6: Stateful middleware

Middleware that tracks state across requests needs thread-safe data structures:

```go
func RequestCounter() http.Middleware {
    var mu sync.Mutex
    var count int64

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            mu.Lock()
            count++
            current := count
            mu.Unlock()

            w.Header().Set("X-Request-Count", strconv.FormatInt(current, 10))
            next.ServeHTTP(w, r)
        })
    }
}
```

This is the pattern used by `RateLimit` — it maintains per-key counters protected by `sync.Mutex`, with periodic garbage collection of expired entries.

{% callout title="Thread safety" type="warning" %}
Every handler runs in its own goroutine. Any shared state in a middleware closure **must** be protected by a mutex or use atomic operations.
{% /callout %}

---

## Pattern 7: Panic recovery

Use `defer` to catch panics and convert them to error responses:

```go
func SafeHandler() http.Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if v := recover(); v != nil {
                    http.WriteError(w, http.StatusInternalServerError, "internal server error")
                }
            }()
            next.ServeHTTP(w, r)
        })
    }
}
```

The built-in `Recovery` middleware does this with an optional callback for logging the panic value and stack trace. You rarely need to write your own — just use `http.Recovery`.

---

## Wiring middleware

### Global middleware

Apply to all routes via the router:

```go
router := http.NewRouter()
router.Use(TimingHeader())
router.Use(LogSlowRequests(logger, 500*time.Millisecond))
```

### Group middleware

Apply to a subset of routes via groups:

```go
api := router.Group("/api")

// Admin routes get extra protection
admin := api.Group("/admin")
admin.Use(RequireAPIKey(validKeys))
admin.Use(TenantFromHeader())

admin.HandleFunc("GET /admin/stats", statsHandler)
```

Groups inherit parent middleware. When a request hits `/api/admin/stats`, the execution order is:

1. Router middleware (global)
2. `/api` group middleware
3. `/api/admin` group middleware
4. `statsHandler`

### Middleware ordering

Middleware runs in the order you call `Use()`. The first middleware added is the **outermost** wrapper — it runs first on the way in and last on the way out:

```go
router.Use(A)  // runs 1st → code before next | code after next ← runs last
router.Use(B)  // runs 2nd → code before next | code after next ← runs 2nd-to-last
router.Use(C)  // runs 3rd → code before next | code after next ← runs 1st after handler
```

Place middleware that other middleware depends on earlier. For example, `RequestID` should run before `RequestLogger` so the logger can include the request ID.

---

## Testing middleware

Test middleware with `httptest`:

```bash
curl -s http://localhost:23710/api/admin/stats -H "X-API-Key: test-key" | jq .
```

```bash
# Verify the timing header is set
curl -sI http://localhost:23710/api/health | grep X-Request-Start
```

```bash
# Test gate-keeping: missing API key should return 401
curl -s http://localhost:23710/api/admin/stats | jq .
# {"error":"invalid API key"}
```

---

## Tips

- Start simple. Most custom middleware is pattern 1 (before) or pattern 3 (gate-keeping). Reach for response wrapping only when you need to observe the response.
- One middleware, one concern. Don't combine logging, auth, and rate limiting into a single middleware — compose them with `Use()`.
- Pre-compute in the outer function. Anything that doesn't change per-request (maps, compiled regex, formatted strings) should be computed once in the closure, not in the handler.
- Avoid allocations in the hot path. Use stack-allocated arrays, `sync.Pool`, and `strings.Builder` instead of `fmt.Sprintf` where performance matters.
- Always implement `Unwrap()` on response writer wrappers so the rest of the middleware chain can find the underlying connection.
