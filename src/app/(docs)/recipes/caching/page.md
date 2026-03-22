---
title: Caching
nextjs:
  metadata:
    title: Caching
    description: How to cache database queries and expensive computations with TTL and LRU eviction.
---

The `pkg/cache` package provides an in-memory TTL cache with generics. This recipe shows practical patterns for caching database queries, API responses, and computed values in a Stanza app.

---

## Dashboard stats caching

The admin dashboard queries 6 database tables on every request. Caching these for 30 seconds reduces load with negligible staleness. This is how the standalone app does it.

### Step 1: Define the cached struct

```go
type dbStats struct {
    TotalAdmins    int   `json:"total_admins"`
    TotalUsers     int   `json:"total_users"`
    ActiveSessions int   `json:"active_sessions"`
    ActiveAPIKeys  int   `json:"active_api_keys"`
    Tables         int   `json:"tables"`
    Migrations     int   `json:"migrations"`
    DBSizeBytes    int64 `json:"db_size_bytes"`
    WALSizeBytes   int64 `json:"wal_size_bytes"`
}
```

### Step 2: Create the cache in `Register`

```go
func Register(admin *http.Group, db *sqlite.DB) {
    statsCache := cache.New[*dbStats](
        cache.WithTTL[*dbStats](30 * time.Second),
        cache.WithMaxSize[*dbStats](1),
    )
    admin.HandleFunc("GET /dashboard", statsHandler(db, statsCache))
}
```

Creating the cache inside `Register` keeps it scoped to the module. No lifecycle wiring needed — it lives as long as the process.

### Step 3: Use GetOrSet in the handler

```go
func statsHandler(db *sqlite.DB, c *cache.Cache[*dbStats]) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        st, _ := c.GetOrSet("stats", func() (*dbStats, error) {
            return queryDBStats(db)
        })
        if st == nil {
            st = &dbStats{}
        }
        http.WriteJSON(w, http.StatusOK, st)
    }
}
```

`GetOrSet` handles the entire check-compute-store cycle. On the first request, it calls `queryDBStats`. For the next 30 seconds, it returns the cached value without touching the database.

---

## Per-entity caching

Cache individual records by encoding the entity ID in the key:

```go
userCache := cache.New[*User](
    cache.WithTTL[*User](5 * time.Minute),
    cache.WithMaxSize[*User](500),
)

func getUser(db *sqlite.DB, id int64) (*User, error) {
    key := fmt.Sprintf("user:%d", id)
    return userCache.GetOrSet(key, func() (*User, error) {
        return findUserByID(db, id)
    })
}
```

When the user is updated, invalidate the cache entry:

```go
func updateUser(db *sqlite.DB, id int64, name string) error {
    // ... update in database ...
    userCache.Delete(fmt.Sprintf("user:%d", id))
    return nil
}
```

---

## Caching with different TTLs

Some data changes rarely (settings), some changes often (session counts). Use `GetOrSetWithTTL` to vary TTL per key:

```go
c := cache.New[any](
    cache.WithTTL[any](1 * time.Minute), // default
)

// Settings rarely change — cache for 10 minutes
settings, _ := c.GetOrSetWithTTL("settings", 10*time.Minute, func() (any, error) {
    return loadSettings(db)
})

// Active user count changes often — cache for 15 seconds
count, _ := c.GetOrSetWithTTL("active-users", 15*time.Second, func() (any, error) {
    return countActiveUsers(db)
})
```

Prefer separate typed caches over `Cache[any]` when the data types differ significantly.

---

## LRU-bounded caches

For caches where entries accumulate (per-user, per-entity), set `WithMaxSize` to cap memory usage:

```go
profileCache := cache.New[*Profile](
    cache.WithTTL[*Profile](10 * time.Minute),
    cache.WithMaxSize[*Profile](1000),
)
```

When the 1001st unique key is inserted, the least recently accessed entry is evicted. `WithMaxSize` and TTL work together — entries can be removed by either mechanism.

---

## Eviction callback for cleanup

If cached values hold resources (open connections, temporary files), use `WithOnEvict` to clean up:

```go
c := cache.New[*TempFile](
    cache.WithTTL[*TempFile](5 * time.Minute),
    cache.WithOnEvict[*TempFile](func(key string, f *TempFile) {
        os.Remove(f.Path)
    }),
)
```

The callback fires on TTL expiration, LRU eviction, explicit `Delete`, and `Clear`. It runs under the cache lock — keep it fast (no network calls, no heavy I/O).

---

## When not to cache

Not everything benefits from caching:

- **In-memory data** — `runtime.MemStats`, goroutine counts, uptime. Already in memory, no I/O.
- **Rarely accessed data** — If a query runs once per hour, caching it adds complexity for no gain.
- **Data that must be real-time** — Active session counts for security decisions, auth token validation.
- **Writes** — Only cache reads. Writes always go to the database.

---

## Tips

- **One cache per data type.** Use `cache.New[*User]` and `cache.New[*Settings]` separately. Generics make this type-safe.
- **Start with short TTLs.** 15–30 seconds is a safe starting point. Increase only when you've measured that staleness is acceptable.
- **Invalidate on write.** After a mutation, call `c.Delete(key)` so the next read fetches fresh data.
- **Create in Register, not globally.** Module-scoped caches are easier to reason about. The standalone dashboard module demonstrates this pattern.
- **Don't cache errors.** `GetOrSet` already handles this — if the function returns an error, nothing is cached, and the next call retries.
