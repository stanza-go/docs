---
title: Observability & health checks
nextjs:
  metadata:
    title: Observability & health checks
    description: Health endpoints, Stats() methods, dashboard wiring, build metadata, and production monitoring for Stanza apps.
---

Every Stanza framework package exposes a `Stats()` method with atomic counters for its key operations. This recipe shows how to build health check endpoints, wire Stats() into an admin dashboard, inject build metadata, and monitor your app in production.

---

## Health check endpoint

A health endpoint answers one question: is the service healthy enough to receive traffic? Keep it simple — check database connectivity and report basic runtime metrics:

```go
package health

import (
    "runtime"
    "time"

    "github.com/stanza-go/framework/pkg/http"
    "github.com/stanza-go/framework/pkg/sqlite"
)

var startTime = time.Now()

type BuildInfo struct {
    Version   string
    Commit    string
    BuildTime string
}

func Register(api *http.Group, db *sqlite.DB, bi BuildInfo) {
    ver := bi.Version
    if ver == "" {
        ver = "dev"
    }

    api.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
        dbOK := true
        var dbErr string
        row := db.QueryRow("SELECT 1")
        var one int
        if err := row.Scan(&one); err != nil {
            dbOK = false
            dbErr = err.Error()
        }

        var mem runtime.MemStats
        runtime.ReadMemStats(&mem)

        status := http.StatusOK
        if !dbOK {
            status = http.StatusServiceUnavailable
        }

        stats := db.Stats()
        http.WriteJSON(w, status, map[string]any{
            "status":     statusText(dbOK),
            "version":    ver,
            "commit":     bi.Commit,
            "uptime":     time.Since(startTime).Round(time.Second).String(),
            "go":         runtime.Version(),
            "goroutines": runtime.NumGoroutine(),
            "memory_mb":  mem.Alloc / 1024 / 1024,
            "database": map[string]any{
                "ok":          dbOK,
                "error":       dbErr,
                "total_reads": stats.TotalReads,
                "total_writes": stats.TotalWrites,
                "pool_size":   stats.ReadPoolSize,
                "pool_in_use": stats.ReadPoolInUse,
                "pool_waits":  stats.PoolWaits,
            },
        })
    })
}

func statusText(ok bool) string {
    if ok {
        return "ok"
    }
    return "degraded"
}
```

The endpoint returns `200 OK` when healthy and `503 Service Unavailable` when the database is unreachable. Container orchestrators (Railway, Cloud Run) use this to route traffic and restart unhealthy instances.

Register it on a public route — no auth required:

```go
health.Register(api, db, health.BuildInfo{
    Version:   version,
    Commit:    commit,
    BuildTime: buildTime,
})
```

Test it:

```bash
curl -s http://localhost:23710/api/health | jq .
```

```json
{
  "status": "ok",
  "version": "dev",
  "uptime": "2m30s",
  "go": "go1.26.1",
  "goroutines": 14,
  "memory_mb": 8,
  "database": {
    "ok": true,
    "error": "",
    "total_reads": 1247,
    "total_writes": 83,
    "pool_size": 4,
    "pool_in_use": 1,
    "pool_waits": 0
  }
}
```

{% callout title="What to check" %}
The health endpoint should verify only critical dependencies — the database and nothing else. Don't check optional services (email, webhooks) here. A failing email provider shouldn't mark the entire service as unhealthy.
{% /callout %}

---

## Build metadata

Inject version, commit hash, and build time at compile time via `-ldflags`:

```go
// main.go — these are empty in development, set by the build.
var (
    version   string
    commit    string
    buildTime string
)
```

The Makefile sets them:

```makefile
go build -ldflags="-s -w \
    -X main.version=$$(git describe --tags --always --dirty) \
    -X main.commit=$$(git rev-parse --short HEAD) \
    -X main.buildTime=$$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -o bin/standalone .
```

This lets you identify exactly which code is running in production by hitting the health endpoint.

---

## Stats() reference

Every framework package with runtime state exposes a `Stats()` method. All counters use `sync/atomic` — safe to call from any goroutine, no locks, no allocations.

### SQLite

```go
stats := db.Stats()
```

| Field | Type | Description |
|-------|------|-------------|
| `ReadPoolSize` | `int` | Configured number of read connections |
| `ReadPoolAvailable` | `int` | Idle connections in pool |
| `ReadPoolInUse` | `int` | Connections currently checked out |
| `TotalReads` | `int64` | Total read queries executed |
| `TotalWrites` | `int64` | Total write operations executed |
| `PoolWaits` | `int64` | Times a read query waited for a free connection |
| `PoolWaitTime` | `time.Duration` | Cumulative time waiting for a free connection |

**What to watch:** `PoolWaits` growing means your read pool is too small for your concurrency. Increase with `sqlite.WithReadPoolSize(n)`.

### HTTP

```go
stats := metrics.Stats()
```

| Field | Type | Description |
|-------|------|-------------|
| `TotalRequests` | `int64` | Total requests processed |
| `ActiveRequests` | `int64` | Currently in-flight requests |
| `Status2xx` | `int64` | Successful responses |
| `Status3xx` | `int64` | Redirects |
| `Status4xx` | `int64` | Client errors |
| `Status5xx` | `int64` | Server errors |
| `BytesWritten` | `int64` | Total response bytes |
| `AvgDurationMs` | `float64` | Average request duration in milliseconds |

**What to watch:** `Status5xx` climbing means server errors. `ActiveRequests` staying high means requests are backing up — check for slow queries or external calls.

### Cache

```go
stats := myCache.Stats()
```

| Field | Type | Description |
|-------|------|-------------|
| `Size` | `int` | Current entries (including expired not yet cleaned) |
| `MaxSize` | `int` | Configured maximum (0 = unlimited) |
| `Hits` | `int64` | Key found and not expired |
| `Misses` | `int64` | Key not found or expired |
| `Evictions` | `int64` | Involuntary removals (TTL expiry + LRU) |

**What to watch:** Hit rate = `Hits / (Hits + Misses)`. Below 80% means your TTL is too short or your cache is too small. High `Evictions` with a full cache means `MaxSize` is too low.

### Queue

```go
stats, err := queue.Stats()
```

| Field | Type | Description |
|-------|------|-------------|
| `Pending` | `int` | Jobs waiting to be processed |
| `Running` | `int` | Jobs currently being processed |
| `Completed` | `int` | Successfully finished jobs |
| `Failed` | `int` | Jobs that errored (will retry) |
| `Dead` | `int` | Jobs that exhausted all retries |
| `Cancelled` | `int` | Manually cancelled jobs |

**What to watch:** `Pending` growing faster than `Completed` means your workers can't keep up. `Dead` increasing means jobs are permanently failing — check error logs.

### Cron

```go
stats := scheduler.Stats()
```

| Field | Type | Description |
|-------|------|-------------|
| `Jobs` | `int` | Total registered jobs |
| `Completed` | `int64` | Successful executions |
| `Failed` | `int64` | Executions that returned error or panicked |
| `Skipped` | `int64` | Skipped because previous execution still running |

**What to watch:** `Skipped` increasing means a cron job takes longer than its interval. Either increase the interval or optimize the job. `Failed` means a job is erroring — check logs.

### Webhook

```go
stats := webhookClient.Stats()
```

| Field | Type | Description |
|-------|------|-------------|
| `Sends` | `int64` | Total Send or SendWithRetry calls |
| `Successes` | `int64` | Deliveries that received 2xx response |
| `Failures` | `int64` | Non-2xx response after retries exhausted |
| `Retries` | `int64` | Total retry attempts |
| `Errors` | `int64` | Network errors (DNS, timeouts, context cancellation) |

**What to watch:** `Failures / Sends` is your delivery failure rate. High `Retries` means endpoints are flaky. High `Errors` means network issues.

### Auth

```go
stats := auth.Stats()
```

| Field | Type | Description |
|-------|------|-------------|
| `Issued` | `int64` | Access tokens successfully created |
| `Accepted` | `int64` | Tokens that passed validation |
| `Rejected` | `int64` | Tokens that failed (expired, malformed, invalid signature) |

**What to watch:** `Rejected` spiking could indicate token expiry issues (clock skew) or attack attempts (forged tokens).

### Email

```go
stats := emailClient.Stats()
```

| Field | Type | Description |
|-------|------|-------------|
| `Sent` | `int64` | Emails successfully delivered to API |
| `Errors` | `int64` | Failed send attempts (transport errors, non-2xx responses) |

**What to watch:** `Errors / (Sent + Errors)` is your email failure rate. Non-zero `Errors` usually means an API key issue or provider outage.

---

## Dashboard endpoint

The admin dashboard aggregates Stats() from all packages into a single JSON response. The key pattern: **call Stats() live for cheap in-memory counters, cache expensive database queries.**

```go
func Register(admin *http.Group, db *sqlite.DB, q *queue.Queue,
    s *cron.Scheduler, m *http.Metrics, wh *webhooks.Dispatcher,
    a *auth.Auth, ec *email.Client) {

    // Cache expensive DB queries (table counts, user counts).
    statsCache := cache.New[*dbStats](
        cache.WithTTL[*dbStats](30 * time.Second),
        cache.WithMaxSize[*dbStats](1),
    )

    admin.HandleFunc("GET /dashboard", statsHandler(db, q, s, m, wh, a, ec, statsCache))
}
```

### Cheap vs expensive stats

| Source | Cost | Strategy |
|--------|------|----------|
| `db.Stats()` | Free — atomic reads | Call live |
| `q.Stats()` | DB query | Call live (fast — indexed) |
| `s.Stats()` | Free — atomic reads | Call live |
| `m.Stats()` | Free — atomic reads | Call live |
| `wh.Stats()` | Free — atomic reads | Call live |
| `a.Stats()` | Free — atomic reads | Call live |
| `ec.Stats()` | Free — atomic reads | Call live |
| Table counts, user counts | Multiple DB queries | Cache 30s |
| Time-series chart data | Complex aggregation | Cache 5m |

### Assembling the response

```go
func statsHandler(db *sqlite.DB, q *queue.Queue, s *cron.Scheduler,
    m *http.Metrics, wh *webhooks.Dispatcher, a *auth.Auth,
    ec *email.Client, statsCache *cache.Cache[*dbStats]) func(http.ResponseWriter, *http.Request) {

    return func(w http.ResponseWriter, r *http.Request) {
        var mem runtime.MemStats
        runtime.ReadMemStats(&mem)

        // Cached — expensive DB queries, 30s TTL.
        st, _ := statsCache.GetOrSet("stats", func() (*dbStats, error) {
            return queryDBStats(db)
        })
        if st == nil {
            st = &dbStats{}
        }

        // Live — all in-memory, no DB hit.
        queueStats := map[string]any{"pending": 0, "running": 0}
        if qs, err := q.Stats(); err == nil {
            queueStats["pending"] = qs.Pending
            queueStats["running"] = qs.Running
            queueStats["completed"] = qs.Completed
            queueStats["failed"] = qs.Failed
            queueStats["dead"] = qs.Dead
        }

        cronStats := s.Stats()

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "system": map[string]any{
                "goroutines":      runtime.NumGoroutine(),
                "memory_alloc_mb": float64(mem.Alloc) / 1024 / 1024,
            },
            "database": map[string]any{
                "size_bytes":   st.DBSizeBytes,
                "total_reads":  db.Stats().TotalReads,
                "total_writes": db.Stats().TotalWrites,
                "pool_waits":   db.Stats().PoolWaits,
            },
            "queue":   queueStats,
            "cron": map[string]any{
                "completed": cronStats.Completed,
                "failed":    cronStats.Failed,
                "skipped":   cronStats.Skipped,
            },
            "http":    m.Stats(),
            "webhook": wh.Stats(),
            "auth":    a.Stats(),
            "email":   ec.Stats(),
            "stats": map[string]any{
                "total_users":     st.TotalUsers,
                "active_sessions": st.ActiveSessions,
            },
        })
    }
}
```

### Wiring in main.go

Pass all stats providers through the lifecycle DI container:

```go
func main() {
    app := lifecycle.New(
        lifecycle.Provide(provideDB),
        lifecycle.Provide(provideAuth),
        lifecycle.Provide(provideEmail),
        lifecycle.Provide(provideQueue),
        lifecycle.Provide(provideWebhookDispatcher),
        lifecycle.Provide(provideCron),
        lifecycle.Provide(provideMetrics),
        lifecycle.Provide(provideRouter),
        lifecycle.Provide(provideServer),
        lifecycle.Invoke(registerModules),
    )
    if err := app.Run(); err != nil {
        fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
        os.Exit(1)
    }
}

func provideMetrics() *http.Metrics {
    return http.NewMetrics()
}
```

The `registerModules` function receives all providers and wires them into the dashboard:

```go
func registerModules(router *http.Router, db *sqlite.DB, q *queue.Queue,
    s *cron.Scheduler, m *http.Metrics, wh *webhooks.Dispatcher,
    a *auth.Auth, ec *email.Client) {

    admin := router.Group("/api/admin")
    admin.Use(a.RequireAuth())
    admin.Use(auth.RequireScope("admin"))

    dashboard.Register(admin, db, q, s, m, wh, a, ec)
}
```

---

## Prometheus metrics endpoint

For external monitoring tools (Prometheus, Grafana, Datadog), expose all framework Stats() in Prometheus text exposition format using `http.PrometheusHandler`. This is a public endpoint — register it alongside the health check:

```go
api.HandleFunc("GET /metrics", http.PrometheusHandler(
    collectPrometheus(db, m, q, s, whDispatcher, a, emailClient),
))
```

The collector function gathers metrics from all framework packages on each scrape:

```go
func collectPrometheus(db *sqlite.DB, m *http.Metrics, q *queue.Queue,
    s *cron.Scheduler, wh *webhooks.Dispatcher, a *auth.Auth,
    ec *email.Client) func() []http.PrometheusMetric {

    return func() []http.PrometheusMetric {
        var out []http.PrometheusMetric

        // SQLite — pool, query counters, and file sizes.
        ds := db.Stats()
        out = append(out,
            http.PrometheusMetric{Name: "stanza_sqlite_reads_total", Help: "Total read queries", Type: "counter", Value: float64(ds.TotalReads)},
            http.PrometheusMetric{Name: "stanza_sqlite_writes_total", Help: "Total write queries", Type: "counter", Value: float64(ds.TotalWrites)},
            http.PrometheusMetric{Name: "stanza_sqlite_pool_waits_total", Help: "Read pool wait events", Type: "counter", Value: float64(ds.PoolWaits)},
            http.PrometheusMetric{Name: "stanza_sqlite_read_pool_in_use", Help: "Read pool connections in use", Type: "gauge", Value: float64(ds.ReadPoolInUse)},
            http.PrometheusMetric{Name: "stanza_sqlite_file_size_bytes", Help: "Main database file size", Type: "gauge", Value: float64(ds.FileSize)},
            http.PrometheusMetric{Name: "stanza_sqlite_wal_size_bytes", Help: "WAL file size", Type: "gauge", Value: float64(ds.WALSize)},
        )

        // HTTP — request counters and latency.
        hs := m.Stats()
        out = append(out,
            http.PrometheusMetric{Name: "stanza_http_requests_total", Help: "Total requests processed", Type: "counter", Value: float64(hs.TotalRequests)},
            http.PrometheusMetric{Name: "stanza_http_requests_active", Help: "Requests in flight", Type: "gauge", Value: float64(hs.ActiveRequests)},
            http.PrometheusMetric{Name: "stanza_http_responses_2xx_total", Help: "2xx responses", Type: "counter", Value: float64(hs.Status2xx)},
            http.PrometheusMetric{Name: "stanza_http_responses_4xx_total", Help: "4xx responses", Type: "counter", Value: float64(hs.Status4xx)},
            http.PrometheusMetric{Name: "stanza_http_responses_5xx_total", Help: "5xx responses", Type: "counter", Value: float64(hs.Status5xx)},
        )

        // Queue — job state counts.
        if qs, err := q.Stats(); err == nil {
            out = append(out,
                http.PrometheusMetric{Name: "stanza_queue_pending", Help: "Pending jobs", Type: "gauge", Value: float64(qs.Pending)},
                http.PrometheusMetric{Name: "stanza_queue_completed_total", Help: "Completed jobs", Type: "counter", Value: float64(qs.Completed)},
                http.PrometheusMetric{Name: "stanza_queue_failed_total", Help: "Failed jobs", Type: "counter", Value: float64(qs.Failed)},
                http.PrometheusMetric{Name: "stanza_queue_dead_total", Help: "Dead-lettered jobs", Type: "counter", Value: float64(qs.Dead)},
            )
        }

        // Cron, webhook, auth, email — same pattern.
        cs := s.Stats()
        out = append(out,
            http.PrometheusMetric{Name: "stanza_cron_completed_total", Help: "Cron runs completed", Type: "counter", Value: float64(cs.Completed)},
            http.PrometheusMetric{Name: "stanza_cron_failed_total", Help: "Cron runs failed", Type: "counter", Value: float64(cs.Failed)},
        )

        ws := wh.Stats()
        out = append(out,
            http.PrometheusMetric{Name: "stanza_webhook_sends_total", Help: "Webhook deliveries attempted", Type: "counter", Value: float64(ws.Sends)},
            http.PrometheusMetric{Name: "stanza_webhook_failures_total", Help: "Webhook deliveries failed", Type: "counter", Value: float64(ws.Failures)},
        )

        as := a.Stats()
        out = append(out,
            http.PrometheusMetric{Name: "stanza_auth_tokens_issued_total", Help: "Tokens issued", Type: "counter", Value: float64(as.Issued)},
            http.PrometheusMetric{Name: "stanza_auth_tokens_rejected_total", Help: "Tokens rejected", Type: "counter", Value: float64(as.Rejected)},
        )

        es := ec.Stats()
        out = append(out,
            http.PrometheusMetric{Name: "stanza_email_sent_total", Help: "Emails sent", Type: "counter", Value: float64(es.Sent)},
            http.PrometheusMetric{Name: "stanza_email_errors_total", Help: "Email errors", Type: "counter", Value: float64(es.Errors)},
        )

        // Go runtime — goroutines, memory, GC.
        out = append(out, http.RuntimeMetrics()...)

        return out
    }
}
```

Test it:

```bash
curl -s http://localhost:23710/api/metrics
```

```text
# HELP stanza_sqlite_reads_total Total read queries
# TYPE stanza_sqlite_reads_total counter
stanza_sqlite_reads_total 1247
# HELP stanza_http_requests_total Total requests processed
# TYPE stanza_http_requests_total counter
stanza_http_requests_total 892
# HELP stanza_queue_pending Pending jobs
# TYPE stanza_queue_pending gauge
stanza_queue_pending 0
# HELP go_goroutines Number of goroutines that currently exist
# TYPE go_goroutines gauge
go_goroutines 12
# HELP go_memstats_alloc_bytes Number of bytes allocated and still in use
# TYPE go_memstats_alloc_bytes gauge
go_memstats_alloc_bytes 4.21888e+06
...
```

### Prometheus scrape config

Point Prometheus at your app's metrics endpoint:

```yaml
scrape_configs:
  - job_name: stanza
    scrape_interval: 30s
    static_configs:
      - targets: ["your-app.up.railway.app"]
    scheme: https
    metrics_path: /api/metrics
```

{% callout title="Counters vs gauges" %}
Use `counter` for values that only go up (requests, errors, bytes). Use `gauge` for values that go up and down (active connections, queue depth, pool usage). Prometheus calculates rates from counters automatically — `rate(stanza_http_requests_total[5m])` gives you requests per second.
{% /callout %}

---

## Adding observability to a new module

When you add a framework package or standalone service that maintains runtime state, follow this pattern:

### 1. Define the stats struct

```go
type ServiceStats struct {
    Processed int64
    Errors    int64
}
```

### 2. Add atomic counters

```go
type Service struct {
    processed atomic.Int64
    errors    atomic.Int64
}

func (s *Service) Stats() ServiceStats {
    return ServiceStats{
        Processed: s.processed.Load(),
        Errors:    s.errors.Load(),
    }
}
```

### 3. Increment in operations

```go
func (s *Service) Do(ctx context.Context) error {
    err := s.process(ctx)
    if err != nil {
        s.errors.Add(1)
        return err
    }
    s.processed.Add(1)
    return nil
}
```

### 4. Wire into the dashboard

Add the service to the dashboard's `Register` function signature and include its stats in the response:

```go
"my_service": svc.Stats(),
```

Atomic counters are the right choice for Stats() — they're lock-free, allocation-free, and safe to read from any goroutine at any time.

---

## Production monitoring

### Railway health checks

Railway automatically monitors your health endpoint. Configure it in `railway.toml`:

```toml
[deploy]
healthcheckPath = "/api/health"
healthcheckTimeout = 10
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 5
```

Railway will restart your service if the health endpoint returns non-200.

### Key metrics to watch

| Metric | Source | Alert threshold |
|--------|--------|----------------|
| Health status | `GET /health` → `status` | Any response != `"ok"` |
| Memory usage | `go_memstats_alloc_bytes` | > 80% of container limit |
| Goroutine count | `go_goroutines` | Sustained growth (leak) |
| GC pause time | `go_gc_pause_total_seconds` | Rate > 100ms/min |
| Heap objects | `go_memstats_heap_objects` | Sustained growth (memory leak) |
| 5xx error rate | `stanza_http_responses_5xx_total` | > 1% of total |
| Queue backlog | `stanza_queue_pending` | Growing over time |
| Dead jobs | `stanza_queue_dead_total` | Any increase |
| Pool waits | `stanza_sqlite_pool_waits_total` | Sustained growth |
| WAL size | `stanza_sqlite_wal_size_bytes` | > 100 MB (checkpoint blocked) |
| Auth rejections | `stanza_auth_tokens_rejected_total` | Sudden spike |
| Email failures | `stanza_email_errors_total` | Any increase |
| Webhook failures | `stanza_webhook_failures_total` | > 5% of sends |

### Polling from external monitoring

For external uptime monitoring (UptimeRobot, Pingdom, or a simple cron), poll the health endpoint:

```bash
# Simple check — exit code 0 if healthy, non-zero if degraded.
curl -sf http://your-app.up.railway.app/api/health > /dev/null
```

```bash
# Detailed check — parse the JSON for specific conditions.
STATUS=$(curl -s http://your-app.up.railway.app/api/health | jq -r '.status')
if [ "$STATUS" != "ok" ]; then
    echo "ALERT: service degraded"
fi
```

### Dashboard polling

The admin panel polls the dashboard endpoint every 30 seconds to show live metrics. The 30-second cache TTL on expensive queries means the dashboard is always responsive — it never waits for a slow aggregation query.

---

## Tips

- **Health endpoint stays public.** No auth — load balancers and monitoring tools need unauthenticated access.
- **Dashboard endpoint stays protected.** It exposes internal counts (users, sessions, queue depth) that shouldn't be public.
- **Stats() is always safe to call.** Atomic reads have zero contention and zero allocations. Call them as often as you need.
- **Cache expensive queries, not Stats().** Framework Stats() methods are free. Database counts, file sizes, and aggregation queries are not — cache those with a 30-second TTL.
- **Don't add Stats() to everything.** Only packages with meaningful runtime state need it. Config, validation, and CLI don't.
- **Use `ReadMemStats` sparingly.** It triggers a stop-the-world pause. The health endpoint, dashboard endpoint, and `RuntimeMetrics()` each call it once per request — don't call it in a hot loop.
- **Return 503 for degraded, not 500.** Container orchestrators treat 503 as "temporarily unavailable" and may retry routing, while 500 suggests a code bug.
