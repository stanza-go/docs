---
title: Application metrics
nextjs:
  metadata:
    title: Application metrics
    description: Recording HTTP metrics, custom business metrics, admin API endpoints, and querying time-series data in a Stanza app.
---

The `pkg/metrics` package gives every Stanza app a built-in time-series database — no Prometheus, no Grafana, no external services. This recipe shows how to wire it into a Stanza app, instrument HTTP requests, record custom business metrics, and expose admin API endpoints for querying.

---

## Wiring the metrics store

Create and start the store in your lifecycle setup. Point it at a subdirectory of your data dir:

```go
func provideMetricsStore(dir datadir.Dir, logger *log.Logger,
    lc *lifecycle.Lifecycle) *metrics.Store {

    store := metrics.New(dir.Metrics,
        metrics.WithSystemMetrics(),
        metrics.WithLogger(logger),
    )
    lc.Append(lifecycle.Hook{
        OnStart: store.Start,
        OnStop:  store.Stop,
    })
    return store
}
```

Add the data directory field in your `datadir` struct:

```go
type Dir struct {
    Root    string
    Metrics string // e.g. ~/.stanza/metrics/
    // ...
}
```

The store starts collecting Go runtime metrics automatically (goroutines, heap, GC) and flushes buffered samples to disk every 5 seconds.

---

## HTTP metrics middleware

Record every HTTP request as two metrics — a request counter and a duration measurement:

```go
func httpMetricsRecorder(store *metrics.Store) func(next http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            rec := &statusRecorder{ResponseWriter: w, status: 200}

            next.ServeHTTP(rec, r)

            path := normalizePath(r.URL.Path)
            status := strconv.Itoa(rec.status)
            elapsed := float64(time.Since(start).Milliseconds())

            store.Record("http_requests", 1,
                "method", r.Method, "path", path, "status", status)
            store.Record("http_request_duration_ms", elapsed,
                "method", r.Method, "path", path, "status", status)
        })
    }
}
```

### Status recorder

Capture the response status code without breaking the response chain. Include `Flush()` support so SSE streaming works through the middleware:

```go
type statusRecorder struct {
    http.ResponseWriter
    status      int
    wroteHeader bool
}

func (r *statusRecorder) WriteHeader(code int) {
    if !r.wroteHeader {
        r.status = code
        r.wroteHeader = true
    }
    r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Flush() {
    if f, ok := r.ResponseWriter.(http.Flusher); ok {
        f.Flush()
    }
}
```

### Path normalization

Replace numeric IDs and UUIDs in paths with `{id}` to keep label cardinality bounded:

```go
func normalizePath(p string) string {
    parts := strings.Split(p, "/")
    for i, part := range parts {
        if isID(part) {
            parts[i] = "{id}"
        }
    }
    return strings.Join(parts, "/")
}

func isID(s string) bool {
    if s == "" {
        return false
    }
    // Numeric IDs.
    allDigit := true
    for _, c := range s {
        if c < '0' || c > '9' {
            allDigit = false
            break
        }
    }
    if allDigit {
        return true
    }
    // UUIDs (8-4-4-4-12 hex pattern).
    if len(s) == 36 && s[8] == '-' && s[13] == '-' && s[18] == '-' && s[23] == '-' {
        return true
    }
    return false
}
```

Without normalization, `/api/users/1`, `/api/users/2`, `/api/users/3` would create three separate series. With it, they all collapse to `/api/users/{id}`.

### Register the middleware

Place it after any Prometheus middleware but before the request logger, so timing is accurate:

```go
router.Use(httpMetricsRecorder(store))
```

---

## Custom business metrics

Record any event that matters to your application. Business metrics follow the same `Record` API:

```go
// Track signups by plan.
store.Record("user_signups", 1, "plan", "pro")

// Track revenue.
store.Record("order_revenue", 49.99, "currency", "USD", "tier", "premium")

// Track feature usage.
store.Record("feature_used", 1, "feature", "export", "format", "csv")

// Track error rates by type.
store.Record("app_errors", 1, "type", "validation", "module", "checkout")
```

`Record` is an in-memory append — it's cheap enough to call on every request, every event, every error. The background flush goroutine handles disk I/O.

---

## Admin metrics API

Expose four endpoints under the admin scope for the admin panel to query metrics:

```go
package adminmetrics

import (
    "strings"
    "time"

    "github.com/stanza-go/framework/pkg/http"
    "github.com/stanza-go/framework/pkg/metrics"
)

func Register(admin *http.Group, store *metrics.Store) {
    admin.HandleFunc("GET /metrics/names", listNames(store))
    admin.HandleFunc("GET /metrics/labels", listLabels(store))
    admin.HandleFunc("GET /metrics/query", queryMetrics(store))
    admin.HandleFunc("GET /metrics/stats", getStats(store))
}
```

### List metric names

```go
func listNames(store *metrics.Store) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        http.WriteJSON(w, http.StatusOK, map[string]any{
            "names": store.Names(),
        })
    }
}
```

### List label values

```go
func listLabels(store *metrics.Store) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        name := r.URL.Query().Get("name")
        key := r.URL.Query().Get("key")
        if name == "" || key == "" {
            http.WriteError(w, http.StatusBadRequest, "name and key required")
            return
        }
        http.WriteJSON(w, http.StatusOK, map[string]any{
            "values": store.LabelValues(name, key),
        })
    }
}
```

### Query time-series

Parse time range, step, aggregation function, and optional label filters from query parameters:

```go
func queryMetrics(store *metrics.Store) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        q := r.URL.Query()
        name := q.Get("name")
        if name == "" {
            http.WriteError(w, http.StatusBadRequest, "name required")
            return
        }

        start, err := time.Parse(time.RFC3339, q.Get("start"))
        if err != nil {
            http.WriteError(w, http.StatusBadRequest, "invalid start time")
            return
        }
        end, err := time.Parse(time.RFC3339, q.Get("end"))
        if err != nil {
            http.WriteError(w, http.StatusBadRequest, "invalid end time")
            return
        }

        step, _ := time.ParseDuration(q.Get("step"))
        if step == 0 {
            step = 1 * time.Minute
        }

        fn := parseAggFn(q.Get("fn"))
        labels := parseLabels(q.Get("labels"))

        result, err := store.Query(metrics.Query{
            Name:   name,
            Start:  start,
            End:    end,
            Step:   step,
            Fn:     fn,
            Labels: labels,
        })
        if err != nil {
            http.WriteError(w, http.StatusInternalServerError, err.Error())
            return
        }

        // Map to JSON-friendly response.
        series := make([]map[string]any, len(result.Series))
        for i, s := range result.Series {
            points := make([]map[string]any, len(s.Points))
            for j, p := range s.Points {
                points[j] = map[string]any{"t": p.T, "v": p.V}
            }
            series[i] = map[string]any{
                "name":   s.Name,
                "labels": s.Labels,
                "points": points,
            }
        }
        http.WriteJSON(w, http.StatusOK, map[string]any{"series": series})
    }
}
```

### Store statistics

```go
func getStats(store *metrics.Store) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        s := store.Stats()
        http.WriteJSON(w, http.StatusOK, map[string]any{
            "series_count":    s.SeriesCount,
            "partition_count": s.PartitionCount,
            "disk_bytes":      s.DiskBytes,
            "oldest_date":     s.OldestDate,
            "newest_date":     s.NewestDate,
        })
    }
}
```

### Helper functions

```go
func parseAggFn(s string) metrics.AggFn {
    switch strings.ToLower(s) {
    case "sum":
        return metrics.Sum
    case "min":
        return metrics.Min
    case "max":
        return metrics.Max
    case "count":
        return metrics.Count
    case "last":
        return metrics.Last
    default:
        return metrics.Avg
    }
}

func parseLabels(s string) map[string]string {
    if s == "" {
        return nil
    }
    labels := make(map[string]string)
    for _, pair := range strings.Split(s, ",") {
        kv := strings.SplitN(pair, "=", 2)
        if len(kv) == 2 {
            labels[strings.TrimSpace(kv[0])] = strings.TrimSpace(kv[1])
        }
    }
    return labels
}
```

### Register under admin scope

In `main.go`, register the metrics module under the base admin scope (read-only system data, like the dashboard):

```go
adminmetrics.Register(admin, store)
```

---

## Querying with curl

Once the admin API is wired, test it:

```bash
# List all metric names.
curl -s -H "Authorization: Bearer $TOKEN" \
    http://localhost:23710/api/admin/metrics/names | jq .
```

```json
{
  "names": [
    "go_alloc_bytes_total",
    "go_frees_total",
    "go_gc_pause_ns",
    "go_gc_runs",
    "go_goroutines",
    "go_heap_alloc_bytes",
    "go_heap_inuse_bytes",
    "go_heap_objects",
    "go_mallocs_total",
    "go_stack_inuse_bytes",
    "go_sys_bytes",
    "http_request_duration_ms",
    "http_requests"
  ]
}
```

```bash
# Query HTTP requests in the last hour, summed per minute.
curl -s -H "Authorization: Bearer $TOKEN" \
    "http://localhost:23710/api/admin/metrics/query?name=http_requests&start=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)&end=$(date -u +%Y-%m-%dT%H:%M:%SZ)&step=1m&fn=sum" | jq .
```

```bash
# Filter by label — only GET requests.
curl -s -H "Authorization: Bearer $TOKEN" \
    "http://localhost:23710/api/admin/metrics/query?name=http_requests&start=2026-03-23T00:00:00Z&end=2026-03-23T23:59:59Z&step=5m&fn=sum&labels=method=GET" | jq .
```

```bash
# Average request duration for POST requests.
curl -s -H "Authorization: Bearer $TOKEN" \
    "http://localhost:23710/api/admin/metrics/query?name=http_request_duration_ms&start=2026-03-23T00:00:00Z&end=2026-03-23T23:59:59Z&step=5m&fn=avg&labels=method=POST" | jq .
```

---

## Tips

- **Normalize paths before recording.** Without normalization, every unique URL with an ID creates a separate series. Use `{id}` placeholders to keep cardinality manageable.
- **Label values must be bounded.** Good labels: `method`, `status`, `plan`, `tier`. Bad labels: `user_id`, `request_id`, `email`. Unbounded labels create series explosion.
- **Record counts as `1`, not durations.** For counting events (requests, signups, errors), record a value of `1` and use `Sum` aggregation. For timing, record the actual duration and use `Avg` or percentile-style queries.
- **Use `Last` for gauge-style metrics.** System metrics (goroutines, heap size) are gauges — `Last` gives you the most recent value in each bucket. `Sum` on a gauge is meaningless.
- **Admin API is read-only.** The admin metrics endpoints only query data — they don't record metrics. Recording happens automatically via middleware and explicit `Record` calls in your business logic.

See the [Metrics](/metrics) reference for the full API, and the [Client-Side Analytics](/recipes/client-analytics) recipe for frontend event tracking.
