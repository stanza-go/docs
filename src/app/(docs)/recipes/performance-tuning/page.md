---
title: Performance tuning
nextjs:
  metadata:
    title: Performance tuning
    description: SQLite pragmas, query optimization, caching, HTTP compression, and Go-level techniques for fast Stanza apps.
---

Stanza targets hundreds to low thousands of users on a single process with a single SQLite database. This recipe covers the performance levers available — from SQLite configuration to HTTP-layer optimizations to Go memory patterns. Most of these are already configured by the framework; this guide explains what they do and how to tune them.

---

## SQLite pragmas

The framework applies these pragmas when the database opens:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
PRAGMA cache_size = -64000;
```

What each one does:

| Pragma | Value | Effect |
|--------|-------|--------|
| `journal_mode` | `WAL` | Write-Ahead Logging — readers don't block writers, writers don't block readers. Essential for concurrent HTTP requests. |
| `synchronous` | `NORMAL` | Fsync on checkpoint, not every commit. Safe with WAL — data survives process crash, but not OS crash mid-write. |
| `foreign_keys` | `ON` | Enforces `REFERENCES` and `ON DELETE CASCADE`. Off by default in SQLite — the framework always enables it. |
| `temp_store` | `MEMORY` | Temporary tables and indexes live in RAM, not disk. Faster for complex queries with sorting or grouping. |
| `mmap_size` | `268435456` | 256 MB of memory-mapped I/O. The OS maps the database file into the process address space for faster random reads. |
| `cache_size` | `-64000` | ~64 MB page cache (negative value = kilobytes). Keeps hot pages in memory to avoid disk reads. |

{% callout title="Busy timeout" %}
The framework also sets a busy timeout (default 5 seconds, configurable with `sqlite.WithBusyTimeout`). When a write is blocked by another write, SQLite retries for up to 5 seconds before returning `SQLITE_BUSY`. This handles brief contention from concurrent requests without application-level retry logic.
{% /callout %}

### Adding custom pragmas

```go
db := sqlite.New(dbPath,
    sqlite.WithBusyTimeout(10000),  // 10 seconds for write-heavy workloads.
    sqlite.WithPragma("PRAGMA query_only = OFF"),
)
```

Custom pragmas run after the defaults.

---

## Query optimization

### Use EXPLAIN QUERY PLAN

Before optimizing, measure. Run `EXPLAIN QUERY PLAN` to see if SQLite uses your indexes:

```sql
EXPLAIN QUERY PLAN
SELECT id, email FROM users WHERE email = ? AND deleted_at IS NULL;
```

Output you want to see:

```
SEARCH users USING INDEX idx_users_email (email=?)
```

Output that means a full table scan (slow on large tables):

```
SCAN users
```

If you see `SCAN`, add an index on the columns in your `WHERE` clause.

### Query builder vs raw SQL

The query builder produces parameterized SQL with no runtime overhead beyond string concatenation. Use it for standard CRUD. Use raw SQL for complex queries that the builder cannot express (window functions, CTEs, complex subqueries).

```go
// Builder: clean, safe, composable.
sql, args := sqlite.Select("id", "email", "name").
    From("users").
    Where("is_active = ?", 1).
    WhereNull("deleted_at").
    OrderBy("created_at", "DESC").
    Limit(25).
    Build()

// Raw SQL: when you need features the builder doesn't have.
sql := `SELECT date(created_at) as day, COUNT(*) as count
    FROM users
    WHERE created_at > ?
    GROUP BY date(created_at)
    ORDER BY day`
```

### Avoid N+1 queries

Load related data in bulk, not one row at a time:

```go
// Bad: N+1 — one query per user to get their role.
for _, user := range users {
    db.QueryRow("SELECT name FROM roles WHERE id = ?", user.RoleID).Scan(&user.RoleName)
}

// Good: JOIN in a single query.
sql, args := sqlite.Select("u.id", "u.email", "r.name AS role_name").
    From("users u").
    LeftJoin("roles r", "r.id = u.role_id").
    WhereNull("u.deleted_at").
    Build()
```

### Use CountFrom for pagination

When listing with pagination, you need both the rows and the total count. The `CountFrom` helper reuses the `WHERE` conditions from your `SELECT` builder:

```go
selectQ := sqlite.Select("id", "email", "name").
    From("users").
    Where("is_active = ?", 1).
    WhereNull("deleted_at")

countQ := sqlite.CountFrom(selectQ)

// Two queries sharing the same filters — no duplication.
var total int
db.QueryRow(countQ.Build()).Scan(&total)

rows, _ := db.Query(selectQ.OrderBy("created_at", "DESC").Limit(25).Offset(0).Build())
```

---

## In-memory caching

The `cache` package provides a generic TTL cache with LRU eviction. Use it for data that is read frequently and changes rarely.

### Cache-aside pattern

```go
// Create a typed cache in your module's Register function.
statsCache := cache.New[*DashboardStats](
    cache.WithTTL[*DashboardStats](30 * time.Second),
    cache.WithMaxSize[*DashboardStats](10),
)

// In the handler: compute on miss, serve from cache on hit.
stats, err := statsCache.GetOrSet("dashboard", func() (*DashboardStats, error) {
    return computeExpensiveStats(db)
})
```

`GetOrSet` calls the function only on a cache miss. Subsequent requests within the TTL window get the cached value with zero database queries.

### Per-entity caching

Cache individual records by ID:

```go
userCache := cache.New[*User](
    cache.WithTTL[*User](5 * time.Minute),
    cache.WithMaxSize[*User](1000),
)

// Read-through.
user, err := userCache.GetOrSet(fmt.Sprintf("user:%d", id), func() (*User, error) {
    return findUserByID(db, id)
})

// Invalidate on write.
userCache.Delete(fmt.Sprintf("user:%d", id))
```

Always invalidate after mutations. The 5-minute TTL is a safety net, not the primary invalidation mechanism.

### What to cache

| Cache | TTL | Why |
|-------|-----|-----|
| Dashboard stats | 30 seconds | Expensive aggregation queries, changes slowly |
| Settings | 5–10 minutes | Rarely changes, read on every request for feature flags |
| Role → scopes mapping | 5 minutes | Read on every auth check, changes rarely |
| User by ID | 1–5 minutes | Frequent lookups from JWT `uid`, avoids repeated queries |

### What not to cache

- **Data you just wrote.** Return the written value directly — don't round-trip through cache.
- **Security-critical state.** Revoked sessions, disabled users — stale cache means stale security.
- **Large result sets.** A 10,000-row list doesn't belong in memory. Paginate instead.
- **Data that changes every request.** Rate limiter counters, request logs — caching adds overhead without benefit.

---

## HTTP compression

The `Compress` middleware gzip-compresses responses, reducing bandwidth for JSON APIs and HTML:

```go
r.Use(http.Compress(http.CompressConfig{
    Level:   gzip.DefaultCompression,
    MinSize: 1024,  // Don't compress responses under 1 KB.
}))
```

How it works:

1. Checks `Accept-Encoding: gzip` on the request
2. Buffers the response up to `MinSize` bytes
3. If the response exceeds `MinSize` and the content type is compressible (JSON, HTML, JS, SVG), it compresses with gzip
4. Sets `Content-Encoding: gzip` and strips `Content-Length`
5. Reuses gzip writers from a `sync.Pool` — no allocation per request

Already-compressed formats (PNG, JPEG, MP4, WOFF2) are excluded automatically. The middleware is safe with WebSocket upgrades — it detects hijacked connections and passes through.

---

## Conditional requests with ETag

The `ETag` middleware saves bandwidth by returning `304 Not Modified` when the response hasn't changed:

```go
r.Use(http.ETag(http.ETagConfig{
    Weak: false,  // Byte-exact identity.
}))
```

Flow:

1. First request: middleware computes CRC32 hash of the response body, sets `ETag: "abc123"` header
2. Second request: client sends `If-None-Match: "abc123"`
3. Middleware matches: returns `304 Not Modified` with no body — no serialization, no bandwidth
4. If the response changed: new ETag, full response

Place `ETag` **after** `Compress` in the middleware chain. ETag computes the hash on the uncompressed body, then Compress compresses it. This ordering ensures the ETag stays stable regardless of compression.

---

## Request body limits

The `MaxBody` middleware caps request body size to prevent memory exhaustion from oversized payloads:

```go
r.Use(http.MaxBody(2 << 20))  // 2 MB global limit.
```

Multipart uploads are exempt — upload handlers set their own limits. JSON API requests rarely exceed a few kilobytes, so 2 MB is generous for normal use and protective against abuse.

---

## Rate limiting

The `RateLimit` middleware prevents abuse on sensitive endpoints:

```go
// 10 login attempts per minute per IP.
authGroup.Use(http.RateLimit(http.RateLimitConfig{
    Limit:   10,
    Window:  time.Minute,
    KeyFunc: http.ClientIP,
    Message: "too many login attempts",
}))
```

The middleware uses a fixed time window with automatic cleanup. Expired entries are purged every `2 * Window` to prevent unbounded memory growth. Response headers (`X-RateLimit-Remaining`, `Retry-After`) let clients handle 429 responses gracefully.

Recommended limits:

| Endpoint | Limit | Window |
|----------|-------|--------|
| Login / password reset | 10 | 1 minute |
| API endpoints (authenticated) | 100 | 1 minute |
| Public endpoints | 1000 | 1 minute |

---

## Go-level optimizations

These patterns are used throughout the framework to reduce heap allocations on hot paths.

### Pre-allocate slices and maps

When you know the size upfront, allocate once:

```go
// Bad: slice grows via append, re-allocating the backing array.
var users []User
for rows.Next() { ... }

// Good: pre-allocate with known capacity.
users := make([]User, 0, total)
for rows.Next() { ... }

// Same for maps.
counts := make(map[string]int, len(categories))
```

### Use strings.Builder for concatenation

```go
// Bad: each += allocates a new string.
result := ""
for _, s := range parts {
    result += s
}

// Good: single allocation with pre-sized builder.
var sb strings.Builder
sb.Grow(estimatedSize)
for _, s := range parts {
    sb.WriteString(s)
}
return sb.String()
```

### Stack-allocated arrays for small buffers

For small fixed-size reads, use arrays instead of slices to avoid heap allocation:

```go
// Bad: make allocates on the heap.
buf := make([]byte, 8)
io.ReadFull(r, buf)

// Good: array stays on the stack.
var buf [8]byte
io.ReadFull(r, buf[:])
```

The framework uses this in WebSocket frame reading (`[2]byte` and `[8]byte` headers) and ETag computation.

### Struct field alignment

Order struct fields by descending size to minimize padding:

```go
// Bad: 32 bytes (padding between fields).
type entry struct {
    active bool    // 1 byte + 7 padding
    value  float64 // 8 bytes
    count  int32   // 4 bytes + 4 padding
    data   int64   // 8 bytes
}

// Good: 24 bytes (no wasted padding).
type entry struct {
    value float64 // 8 bytes
    data  int64   // 8 bytes
    count int32   // 4 bytes
    active bool   // 1 byte + 3 padding
}
```

This matters for structs allocated per request or per row — saving 8 bytes across 10,000 rows adds up.

### Reuse objects with sync.Pool

For expensive-to-create objects used on every request:

```go
var bufPool = sync.Pool{
    New: func() any {
        b := new(bytes.Buffer)
        b.Grow(1024)
        return b
    },
}

func handler(w http.ResponseWriter, r *http.Request) {
    buf := bufPool.Get().(*bytes.Buffer)
    buf.Reset()
    defer bufPool.Put(buf)

    // Use buf — it comes pre-allocated.
}
```

The framework uses pools in the Compress middleware (gzip writers) and ETag middleware (response buffers).

---

## Profiling

Go's built-in profiler identifies where time and memory are spent.

### CPU profiling

```go
import "runtime/pprof"

f, _ := os.Create("cpu.prof")
pprof.StartCPUProfile(f)
defer pprof.StopCPUProfile()
```

Analyze with:

```bash
go tool pprof -http=:8080 cpu.prof
```

### Memory profiling

```go
f, _ := os.Create("mem.prof")
runtime.GC()
pprof.WriteHeapProfile(f)
```

### Benchmarking

Write benchmarks for hot paths:

```go
func BenchmarkCreateJWT(b *testing.B) {
    key := make([]byte, 32)
    claims := Claims{UID: "123", Scopes: []string{"admin"}, ExpiresAt: time.Now().Add(time.Hour).Unix()}

    b.ResetTimer()
    for b.Loop() {
        CreateJWT(key, claims)
    }
}
```

Run with:

```bash
go test -bench=BenchmarkCreateJWT -benchmem ./pkg/auth/...
```

The `-benchmem` flag shows allocations per operation — the number to minimize.

---

## The checklist

Use this when reviewing performance:

1. **SQLite pragmas set?** WAL mode, 64 MB cache, 256 MB mmap — the framework handles this, but verify with `PRAGMA journal_mode` if uncertain.
2. **Indexes on WHERE/JOIN columns?** Run `EXPLAIN QUERY PLAN` on slow queries. A `SCAN` means a missing index.
3. **No N+1 queries?** Use JOINs or batch queries instead of loops.
4. **Hot data cached?** Dashboard stats, settings, role lookups — anything queried more than once per request.
5. **Cache invalidated on write?** Stale cache is worse than no cache.
6. **Compress middleware enabled?** JSON responses compress 60–80%.
7. **ETag middleware enabled?** Saves bandwidth for unchanged responses.
8. **Slices pre-allocated?** `make([]T, 0, n)` when `n` is known.
9. **String building with Builder?** Not `+=` in loops.
10. **Struct fields aligned?** Descending size order for per-request/per-row structs.
