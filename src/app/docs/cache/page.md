---
title: Cache
nextjs:
  metadata:
    title: Cache
    description: In-memory TTL cache with generics, LRU eviction, and cache-aside pattern.
---

The `pkg/cache` package provides a generic in-memory key-value cache with TTL-based expiration, optional LRU eviction, and a cache-aside pattern for transparent loading. It is built entirely on Go's standard library — no external dependencies.

```go
import "github.com/stanza-go/framework/pkg/cache"
```

---

## Creating a cache

Create a cache with the value type as a type parameter and configure it with functional options:

```go
c := cache.New[string](
    cache.WithTTL[string](5 * time.Minute),
)
defer c.Close()
```

The cache starts a background goroutine for periodic cleanup of expired entries. Call `Close` to stop it when the cache is no longer needed.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `WithTTL(d)` | `5m` | Default time-to-live for entries |
| `WithMaxSize(n)` | `0` (unlimited) | Maximum number of entries; triggers LRU eviction when full |
| `WithCleanupInterval(d)` | `1m` | How often the background goroutine sweeps expired entries; `0` disables it |
| `WithOnEvict(fn)` | — | Callback fired on eviction (expiration, LRU, or explicit delete) |

---

## Get and Set

```go
c.Set("greeting", "hello")

val, ok := c.Get("greeting") // "hello", true
```

`Get` returns the value and `true` if the key exists and has not expired, or the zero value and `false` otherwise. Accessing an entry updates its last-accessed time for LRU tracking.

### Per-entry TTL

Override the default TTL for a specific entry:

```go
c.SetWithTTL("session:abc", sessionData, 30*time.Minute)
```

A TTL of `0` uses the cache's default.

---

## Cache-aside pattern

`GetOrSet` checks the cache first. On a miss, it calls the function to compute the value, caches it, and returns it. If the function returns an error, the value is not cached.

```go
user, err := c.GetOrSet("user:42", func() (*User, error) {
    return db.FindUser(42)
})
```

This eliminates the check-then-set boilerplate and ensures only one code path for loading data.

Use `GetOrSetWithTTL` for a custom TTL:

```go
stats, err := c.GetOrSetWithTTL("dashboard", 30*time.Second, func() (*Stats, error) {
    return queryStats(db)
})
```

---

## LRU eviction

When `WithMaxSize` is set, the cache evicts the least recently accessed entry when a new key is inserted at capacity. Access time is updated on every `Get`, so frequently read entries stay in the cache.

```go
c := cache.New[string](
    cache.WithMaxSize[string](1000),
    cache.WithTTL[string](10 * time.Minute),
)
```

LRU eviction and TTL expiration work together — entries can be removed by either mechanism.

---

## Eviction callback

Register a callback to react when entries leave the cache — for logging, metrics, or resource cleanup:

```go
c := cache.New[*Connection](
    cache.WithOnEvict[*Connection](func(key string, conn *Connection) {
        conn.Close()
    }),
)
```

The callback fires on expiration, LRU eviction, explicit `Delete`, and `Clear`. It runs synchronously under the cache lock — keep it fast.

---

## Other operations

```go
c.Delete("key")      // remove a specific entry
c.Clear()            // remove all entries
c.Len()              // number of entries (including expired but not yet cleaned up)
c.Keys()             // list of all keys
c.Close()            // stop the background cleanup goroutine
```

`Close` is safe to call multiple times. After `Close`, the cache can still be used for `Get`/`Set`/`Delete` but no automatic cleanup occurs.

---

## Cache stats

`Stats` returns a snapshot of cache performance counters — useful for monitoring hit rates and diagnosing sizing issues:

```go
s := c.Stats()
fmt.Println(s.Hits, s.Misses, s.Evictions, s.Size)
```

| Field | Type | Description |
|-------|------|-------------|
| `Size` | `int` | Current number of entries |
| `MaxSize` | `int` | Configured maximum (0 = unlimited) |
| `Hits` | `int64` | Total cache hits (key found and not expired) |
| `Misses` | `int64` | Total cache misses (key not found or expired) |
| `Evictions` | `int64` | Total involuntary removals (TTL expiry + LRU) |

Counters are cumulative since the cache was created. They use `sync/atomic` so `Stats` can be called concurrently without affecting cache performance.

---

## Thread safety

All methods are safe for concurrent use. Reads use `sync.RWMutex` read locks; writes use full locks. One reader and one writer can operate concurrently on different keys without contention.

---

## Lifecycle integration

In a Stanza app, close the cache on shutdown:

```go
lc.Append(lifecycle.Hook{
    OnStop: func(ctx context.Context) error {
        c.Close()
        return nil
    },
})
```

Or create the cache inside a module's `Register` function — it will be garbage collected when the process exits. This is the pattern used in the standalone dashboard module.

---

## API reference

| Method | Signature | Description |
|--------|-----------|-------------|
| `New` | `New[V any](opts ...Option[V]) *Cache[V]` | Create a new cache |
| `Get` | `(key string) (V, bool)` | Retrieve value; updates LRU access time |
| `Set` | `(key string, value V)` | Store with default TTL |
| `SetWithTTL` | `(key string, value V, ttl time.Duration)` | Store with custom TTL |
| `GetOrSet` | `(key string, fn func() (V, error)) (V, error)` | Cache-aside with default TTL |
| `GetOrSetWithTTL` | `(key string, ttl time.Duration, fn func() (V, error)) (V, error)` | Cache-aside with custom TTL |
| `Delete` | `(key string)` | Remove an entry |
| `Clear` | `()` | Remove all entries |
| `Len` | `() int` | Entry count |
| `Keys` | `() []string` | All keys |
| `Stats` | `() CacheStats` | Performance counters (hits, misses, evictions, size) |
| `Close` | `()` | Stop background cleanup |

---

## Tips

- **Short TTLs for dashboard stats.** Use 15–30s TTLs for data shown on polling admin pages. The data is always slightly stale anyway.
- **One cache per concern.** Create separate caches for different data types rather than sharing one `Cache[any]`. Generics make this type-safe and free.
- **Don't cache what's already fast.** In-memory data (goroutine counts, `runtime.MemStats`) doesn't need caching. Cache database queries and external API calls.
- **Close is optional for process-scoped caches.** If the cache lives for the entire process lifetime, the cleanup goroutine will be stopped when the process exits.

See the [Caching](/docs/recipes/caching) recipe for integration patterns with real examples from the standalone app.
