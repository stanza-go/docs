---
title: Rate limiting
nextjs:
  metadata:
    title: Rate limiting
    description: How to protect endpoints from abuse with per-IP and per-key rate limiting using the built-in RateLimit middleware.
---

The `RateLimit` middleware limits requests per key (default: client IP) using a fixed time window. This recipe covers practical patterns for protecting auth endpoints, applying tiered limits, rate limiting by API key, and testing your configuration.

---

## Protecting auth endpoints

Auth endpoints are the primary target for brute-force attacks. The standalone app rate limits all auth routes at 20 requests per minute per IP:

```go
func registerModules(router *http.Router, db *sqlite.DB, a *auth.Auth) {
    api := router.Group("/api")

    // Rate limit auth endpoints to prevent brute force attacks.
    // 20 req/min per IP covers legitimate use (status polling from
    // multiple tabs) while stopping automated attacks.
    authRL := api.Group("")
    authRL.Use(http.RateLimit(http.RateLimitConfig{
        Limit:   20,
        Window:  time.Minute,
        Message: "too many requests, please try again later",
    }))
    authRL.HandleFunc("POST /auth/login", loginHandler)
    authRL.HandleFunc("POST /auth/register", registerHandler)
    authRL.HandleFunc("POST /auth/forgot-password", forgotHandler)
    authRL.HandleFunc("POST /auth/status", statusHandler)

    // Other routes — no rate limit
    admin := api.Group("/admin")
    admin.Use(a.RequireAuth())
    // ...
}
```

The group uses an empty prefix (`""`) so the routes keep their original paths. Only the auth routes get rate limited — everything else passes through normally.

---

## Choosing limits

The right limit depends on the endpoint's purpose and expected usage:

| Endpoint type | Suggested limit | Rationale |
|---------------|----------------|-----------|
| Login / register | 10–20/min | Stops brute force, allows a few retries |
| Password reset | 5–10/min | Low legitimate volume, high abuse risk |
| Status polling | 20–30/min | Frontend polls every ~60s, multi-tab safe |
| Public API | 60–120/min | General abuse protection |
| Authenticated API | 300–600/min | Higher limits for known users |

Start conservative and increase based on real usage. The `X-RateLimit-Remaining` header in responses tells you how close clients are getting to the limit.

{% callout title="Status polling" %}
The standalone frontend polls `/auth/status` every 60 seconds per active tab. If a user has 3 tabs open, that's 3 req/min. A limit of 20/min provides comfortable headroom.
{% /callout %}

---

## Tiered rate limiting

Apply different limits to different route groups. Each `RateLimit` call creates an independent limiter with its own counters:

```go
api := router.Group("/api")

// Tight limit on auth — brute force protection
authRL := api.Group("")
authRL.Use(http.RateLimit(http.RateLimitConfig{
    Limit:  20,
    Window: time.Minute,
}))
authRL.HandleFunc("POST /auth/login", loginHandler)
authRL.HandleFunc("POST /auth/register", registerHandler)

// Moderate limit on public endpoints
publicRL := api.Group("")
publicRL.Use(http.RateLimit(http.RateLimitConfig{
    Limit:  60,
    Window: time.Minute,
}))
publicRL.HandleFunc("GET /products", listProductsHandler)
publicRL.HandleFunc("GET /products/{id}", getProductHandler)

// Higher limit for authenticated users
authed := api.Group("")
authed.Use(a.RequireAuth())
authed.Use(http.RateLimit(http.RateLimitConfig{
    Limit:  300,
    Window: time.Minute,
}))
authed.HandleFunc("GET /user/orders", listOrdersHandler)
authed.HandleFunc("POST /user/orders", createOrderHandler)
```

Each limiter tracks its own set of keys independently. A client hitting the login endpoint 20 times doesn't affect their quota on the products endpoint.

---

## Rate limiting by API key

For API-key-authenticated endpoints, rate limit by key instead of IP. This prevents one customer's heavy usage from blocking another customer sharing the same IP (common behind corporate proxies):

```go
apiKeyGroup := api.Group("")
apiKeyGroup.Use(auth.RequireAPIKeyAuth())
apiKeyGroup.Use(http.RateLimit(http.RateLimitConfig{
    Limit:  100,
    Window: time.Minute,
    KeyFunc: func(r *http.Request) string {
        // Use the API key from the Authorization header
        key := r.Header.Get("Authorization")
        if strings.HasPrefix(key, "Bearer ") {
            return key[7:]
        }
        return http.ClientIP(r) // fallback to IP
    },
}))
```

### Rate limiting by authenticated user

For JWT-authenticated endpoints, rate limit by user ID:

```go
authed := api.Group("")
authed.Use(a.RequireAuth())
authed.Use(http.RateLimit(http.RateLimitConfig{
    Limit:  300,
    Window: time.Minute,
    KeyFunc: func(r *http.Request) string {
        claims, ok := auth.ClaimsFrom(r.Context())
        if ok {
            return "user:" + claims.UID
        }
        return http.ClientIP(r)
    },
}))
```

Place the rate limit middleware **after** the auth middleware so that `ClaimsFrom` has a value to read.

---

## Rate limiting behind proxies

When deployed behind a reverse proxy (Railway, Cloud Run, Nginx), the client's real IP is in the `X-Forwarded-For` header, not `RemoteAddr`. The default `KeyFunc` handles this automatically using `ClientIP`:

```go
ip := http.ClientIP(r)
// Checks: X-Forwarded-For → X-Real-IP → RemoteAddr
```

`X-Forwarded-For` may contain multiple IPs (`client, proxy1, proxy2`). `ClientIP` extracts the first entry — the original client. This works correctly on Railway and Cloud Run where the platform sets the header.

{% callout title="IP spoofing" type="warning" %}
`X-Forwarded-For` can be spoofed by the client when there's no trusted proxy. This is only a concern if your app is directly exposed to the internet without a load balancer. On Railway and Cloud Run, the platform strips and re-adds the header, making it trustworthy.
{% /callout %}

---

## Per-endpoint rate limiting

For fine-grained control, apply rate limiting to individual routes by creating a group with a single handler:

```go
// Strict limit on password reset — 5 per minute
resetRL := api.Group("")
resetRL.Use(http.RateLimit(http.RateLimitConfig{
    Limit:   5,
    Window:  time.Minute,
    Message: "too many password reset attempts",
}))
resetRL.HandleFunc("POST /auth/forgot-password", forgotHandler)

// Separate limit on login — 10 per minute
loginRL := api.Group("")
loginRL.Use(http.RateLimit(http.RateLimitConfig{
    Limit:   10,
    Window:  time.Minute,
    Message: "too many login attempts, please wait",
}))
loginRL.HandleFunc("POST /auth/login", loginHandler)
```

Each group has its own limiter instance, so the counters are fully independent.

---

## Response headers

Every response from a rate-limited endpoint includes these headers:

```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 17
X-RateLimit-Reset: 1711234560
```

When the limit is exceeded, the response also includes `Retry-After`:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 42
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1711234560

{"error":"too many requests, please try again later"}
```

### Frontend retry pattern

Use the `Retry-After` header to automatically retry after the window resets:

```typescript
async function fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(url, options)

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10)
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000))
    return fetch(url, options)
  }

  return res
}
```

---

## Testing rate limits

Verify rate limiting works with curl:

```bash
# Send 25 requests rapidly — the last 5 should return 429
for i in $(seq 1 25); do
  status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:23710/api/auth/status)
  echo "Request $i: $status"
done
```

Check the rate limit headers:

```bash
curl -sI http://localhost:23710/api/auth/status | grep -i "x-ratelimit\|retry-after"
# X-RateLimit-Limit: 20
# X-RateLimit-Remaining: 19
# X-RateLimit-Reset: 1711234560
```

Verify that different IPs get independent limits:

```bash
# Request as IP 1.2.3.4
curl -s -H "X-Forwarded-For: 1.2.3.4" http://localhost:23710/api/auth/status

# Request as IP 5.6.7.8 — has its own counter
curl -s -H "X-Forwarded-For: 5.6.7.8" http://localhost:23710/api/auth/status
```

---

## Tips

- **Rate limit auth routes first.** Login, registration, and password reset are the highest-risk endpoints. Everything else can wait.
- **Use empty-prefix groups for rate limiting.** `api.Group("")` lets you apply middleware to specific routes without changing their paths.
- **Place rate limit after auth middleware.** If your `KeyFunc` reads JWT claims, the auth middleware must run first to populate the context.
- **Don't rate limit health endpoints.** Health checks are called by load balancers and monitoring — rate limiting them can cause false downtime alerts.
- **Memory is bounded automatically.** Expired rate limit entries are garbage collected every two window durations. No manual cleanup needed.
- **Each `RateLimit` call creates an independent limiter.** Two groups with separate `RateLimit` middleware have completely separate counters, even for the same client IP.
