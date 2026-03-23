---
title: Metrics
nextjs:
  metadata:
    title: Metrics
    description: Column-oriented time-series storage for application and business metrics with automatic partitioning, pruning, and Go runtime collection.
---

The `pkg/metrics` package provides a column-oriented time-series database for recording, querying, and automatically pruning application metrics. It replaces external monitoring stacks (Prometheus, Grafana) and analytics platforms (PostHog, Google Analytics) with a single, zero-dependency engine that runs inside your Stanza process.

```go
import "github.com/stanza-go/framework/pkg/metrics"
```

---

## Creating a store

Create a metrics store with a directory path and optional configuration:

```go
store := metrics.New("/path/to/metrics",
    metrics.WithSystemMetrics(),
    metrics.WithLogger(logger),
)
```

All metric data — partitions, series registry, column files — is persisted under the given directory. The directory is created automatically on `Start`.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `WithRetention(d)` | `30 * 24h` | Data retention period; partitions older than this are pruned hourly |
| `WithFlushInterval(d)` | `5s` | How often the in-memory buffer is flushed to disk |
| `WithFlushSize(n)` | `1024` | Buffer size that triggers an immediate flush |
| `WithSystemMetrics()` | disabled | Enables Go runtime metrics collection every 10 seconds |
| `WithLogger(l)` | — | Logger for start/stop, flush errors, and prune operations |

---

## Lifecycle integration

The store must be started before recording and stopped on shutdown. Integrate with the lifecycle system:

```go
lc.Append(lifecycle.Hook{
    OnStart: store.Start,
    OnStop:  store.Stop,
})
```

`Start` creates the data directory, loads the series registry, and launches background goroutines for periodic flushing, pruning, and optional system metrics collection.

`Stop` flushes remaining buffered data, closes all partitions, saves the series registry, and waits for all background goroutines to finish.

---

## Recording metrics

`Record` writes a metric sample with a name, value, and optional labels:

```go
store.Record("http_requests", 1, "method", "GET", "status", "200")
store.Record("order_total", 49.99, "currency", "USD")
store.Record("cpu_usage", 0.85)
```

Labels are alternating key-value string pairs. An odd trailing label is ignored. Samples are buffered in memory and flushed to disk periodically (every 5 seconds by default) or when the buffer reaches `flushSize`.

Each unique combination of metric name + labels creates a **series**. The series registry maps these combinations to numeric IDs for compact storage:

```
http_requests{method=GET,status=200}  → series ID 1
http_requests{method=POST,status=201} → series ID 2
order_total{currency=USD}             → series ID 3
```

{% callout title="Label cardinality" %}
Keep label values bounded. Labels like `user_id` or `request_id` create a new series per unique value, bloating the registry. Use labels for dimensions you'll filter and aggregate by — `method`, `status`, `path`, `tier` — not unique identifiers.
{% /callout %}

---

## Querying metrics

`Query` retrieves time-series data with optional aggregation:

```go
result, err := store.Query(metrics.Query{
    Name:  "http_requests",
    Start: time.Now().Add(-1 * time.Hour),
    End:   time.Now(),
    Step:  1 * time.Minute,
    Fn:    metrics.Sum,
    Labels: map[string]string{
        "method": "GET",
    },
})
```

### Query fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `Name` | `string` | yes | Metric name to query |
| `Start` | `time.Time` | yes | Range start (inclusive) |
| `End` | `time.Time` | yes | Range end (inclusive) |
| `Step` | `time.Duration` | no | Aggregation interval; `0` returns raw samples |
| `Fn` | `AggFn` | no | Aggregation function; default `Avg` |
| `Labels` | `map[string]string` | no | Label filters — all specified keys must match exactly |

### Aggregation functions

| Function | Description |
|----------|-------------|
| `Sum` | Sum of values in each step |
| `Avg` | Average of values in each step |
| `Min` | Minimum value in each step |
| `Max` | Maximum value in each step |
| `Count` | Number of samples in each step |
| `Last` | Last value in each step |

### Result structure

The result contains one `SeriesData` entry per matching series:

```go
for _, series := range result.Series {
    fmt.Println(series.Name, series.Labels)
    for _, pt := range series.Points {
        fmt.Printf("  %v: %.2f\n", time.UnixMilli(pt.T), pt.V)
    }
}
```

Each `Point` has `T` (Unix milliseconds) and `V` (float64 value). When `Step > 0`, points are evenly spaced at the step interval with aggregated values. When `Step == 0`, raw samples are returned.

---

## Listing metrics and labels

Discover what metrics exist and what label values are available:

```go
// All registered metric names, sorted alphabetically.
names := store.Names()

// All unique values for a label key on a metric, sorted.
methods := store.LabelValues("http_requests", "method")
// → ["DELETE", "GET", "PATCH", "POST"]
```

These are useful for building metric pickers and label filters in admin UIs.

---

## Store statistics

`Stats` returns a snapshot of storage state:

```go
s := store.Stats()
fmt.Println(s.SeriesCount, s.PartitionCount, s.DiskBytes)
```

| Field | Type | Description |
|-------|------|-------------|
| `SeriesCount` | `int` | Number of unique time series (name + label combinations) |
| `PartitionCount` | `int` | Number of daily partitions on disk |
| `DiskBytes` | `int64` | Total bytes used by column files |
| `OldestDate` | `string` | Oldest partition date (`YYYY-MM-DD`) |
| `NewestDate` | `string` | Newest partition date (`YYYY-MM-DD`) |

---

## System metrics

When `WithSystemMetrics()` is enabled, the store automatically records Go runtime metrics every 10 seconds:

| Metric | Description |
|--------|-------------|
| `go_goroutines` | Current goroutine count |
| `go_heap_alloc_bytes` | Heap bytes allocated and still in use |
| `go_heap_inuse_bytes` | Heap bytes in spans with at least one object |
| `go_heap_objects` | Number of allocated heap objects |
| `go_stack_inuse_bytes` | Stack bytes in use by goroutines |
| `go_gc_pause_ns` | Duration of most recent GC pause (nanoseconds) |
| `go_gc_runs` | Total completed GC cycles |
| `go_alloc_bytes_total` | Cumulative bytes allocated (even if freed) |
| `go_sys_bytes` | Total bytes obtained from OS |
| `go_mallocs_total` | Cumulative heap allocations |
| `go_frees_total` | Cumulative heap frees |

These metrics have no labels — one series each. They provide a baseline of application health without any manual instrumentation.

---

## Storage design

The store uses a column-oriented layout with daily partitioning:

```
metrics/
├── series.txt           ← series registry (name + labels → ID)
├── 2026-03-23/          ← daily partition
│   ├── ts.col           ← timestamps ([]int64, 8 bytes each)
│   ├── sid.col          ← series IDs ([]uint64, 8 bytes each)
│   └── val.col          ← values ([]float64, 8 bytes each)
├── 2026-03-22/
│   └── ...
```

Row N across all three column files represents the same sample. This layout enables:

- **Efficient time-range queries** — only partition directories overlapping the query range are scanned.
- **Simple append writes** — each column file is append-only within a partition.
- **Easy pruning** — deleting a partition is just removing a directory.
- **Compact storage** — 24 bytes per sample (8 bytes × 3 columns), no encoding overhead.

The series registry (`series.txt`) is a tab-separated text file mapping `name\tlabel1=val1,label2=val2` to numeric series IDs. It's append-only on disk with an in-memory lookup protected by `RWMutex`.

### Write path

1. `Record()` resolves the series ID (creating a new one if needed)
2. Sample is appended to an in-memory buffer
3. Buffer is flushed to disk when it reaches `flushSize` or every `flushInterval`
4. On flush, samples are sorted by timestamp and grouped by date partition

### Query path

1. Find matching series IDs from the registry (by name and label filters)
2. Scan only partition directories overlapping the time range
3. Read column files with `ReadAt` (doesn't affect write position)
4. Filter by series ID and time range
5. Check the in-memory buffer for unflushed samples
6. Aggregate into time buckets if `Step > 0`

---

## Auto-pruning

A background goroutine runs every hour and deletes partition directories older than the retention period (default 30 days). This is simple directory deletion — no compaction, no tombstones. The retention window slides forward automatically.

To customize retention:

```go
store := metrics.New(dir,
    metrics.WithRetention(7 * 24 * time.Hour), // keep 7 days
)
```

---

## Thread safety

All methods are safe for concurrent use. Multiple goroutines can call `Record` simultaneously, and queries can run concurrently with writes. Internal locks protect the buffer, partitions, and series registry. Queries use `ReadAt` on column files, which doesn't interfere with append writes.

---

## API reference

### Store

| Method | Signature | Description |
|--------|-----------|-------------|
| `New` | `New(dir string, opts ...Option) *Store` | Create a new store |
| `Start` | `(ctx context.Context) error` | Initialize and start background goroutines |
| `Stop` | `(ctx context.Context) error` | Flush, close partitions, stop goroutines |
| `Record` | `(name string, value float64, labels ...string)` | Record a metric sample |
| `Query` | `(q Query) (*Result, error)` | Query time-series data |
| `Names` | `() []string` | List all metric names |
| `LabelValues` | `(name, labelKey string) []string` | List label values for a metric |
| `Stats` | `() StoreStats` | Storage statistics snapshot |

### Types

| Type | Description |
|------|-------------|
| `Point` | `{T int64, V float64}` — timestamp (Unix ms) and value |
| `SeriesData` | `{Name string, Labels map[string]string, Points []Point}` — one series from a query |
| `Result` | `{Series []SeriesData}` — complete query result |
| `Query` | Query parameters (name, labels, start, end, step, fn) |
| `StoreStats` | Storage statistics (series count, partitions, disk bytes, date range) |
| `AggFn` | Aggregation function enum (Sum, Avg, Min, Max, Count, Last) |
| `Option` | Functional option for store configuration |

---

## Tips

- **One store per application.** All metrics — system, HTTP, business, client — go into the same store. Series are separated by name and labels, not by store instance.
- **Use `WithSystemMetrics()` in production.** It adds 11 series with negligible overhead (one `runtime.ReadMemStats` call every 10 seconds) and gives you instant visibility into goroutine leaks, memory growth, and GC behavior.
- **Record at the point of interest.** Don't batch or delay metrics recording — `Record` is cheap (in-memory append). The flush goroutine handles disk I/O in the background.
- **Choose Step wisely for queries.** A 1-minute step over 24 hours produces 1,440 points per series. For longer ranges (7d, 30d), increase the step (5m, 1h) to keep responses manageable.
- **Label filters are exact match.** There's no regex or wildcard matching. Design label values to be filterable — use `status=200` not `status=200 OK`.

See the [Application Metrics](/recipes/application-metrics) recipe for HTTP and business metric patterns, and the [Client-Side Analytics](/recipes/client-analytics) recipe for frontend event tracking.
