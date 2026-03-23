---
title: Client-side analytics
nextjs:
  metadata:
    title: Client-side analytics
    description: Frontend event tracking with the public metrics API — page views, custom events, batching, and viewing analytics in the admin panel.
---

Stanza includes a public API endpoint for recording client-side metrics from frontend JavaScript. This replaces external analytics tools (Google Analytics, PostHog, Plausible) with a built-in solution that stores data in the same metrics engine used for server-side metrics. This recipe shows how to set up the endpoint, instrument your frontend, and view the results in the admin panel.

---

## The client metrics endpoint

The standalone app ships with a `clientmetrics` module that exposes `POST /api/metrics` as a public endpoint — no authentication required, so unauthenticated pages can still track events.

### Single metric

```bash
curl -X POST http://localhost:23710/api/metrics \
    -H "Content-Type: application/json" \
    -d '{"name": "page_view", "value": 1, "labels": {"page": "/home"}}'
```

```json
{"recorded": 1}
```

### Batch metrics

Send up to 20 metrics in a single request for efficiency:

```bash
curl -X POST http://localhost:23710/api/metrics \
    -H "Content-Type: application/json" \
    -d '{
        "metrics": [
            {"name": "page_view", "value": 1, "labels": {"page": "/home"}},
            {"name": "click", "value": 1, "labels": {"element": "signup_btn"}},
            {"name": "time_on_page", "value": 4500, "labels": {"page": "/pricing"}}
        ]
    }'
```

```json
{"recorded": 3}
```

### Auto-prefixing

All client-submitted metric names are automatically prefixed with `client_`. If you send `page_view`, it's stored as `client_page_view`. This prevents client-side metrics from colliding with or spoofing system metrics like `http_requests` or `go_goroutines`.

### Validation rules

| Rule | Constraint |
|------|-----------|
| Metric name | Lowercase alphanumeric + underscores, starts with letter, max 128 chars |
| Name prefix | Must not start with `client_` (added automatically) |
| Labels per metric | Max 10 |
| Label key | Lowercase alphanumeric + underscores, starts with letter, max 64 chars |
| Label value | Max 128 chars |
| Batch size | Max 20 metrics per request |
| Body size | Max 64 KB |

### Rate limiting

The endpoint is rate-limited to 60 requests per minute per IP. Since each request can batch up to 20 metrics, this allows ~1,200 metric events per minute per client — more than enough for typical frontend analytics.

---

## Setting up the endpoint

Register the client metrics module on a rate-limited sub-group of your public API:

```go
package clientmetrics

import (
    "encoding/json"
    "net/http"
    "regexp"
    "strings"

    shttp "github.com/stanza-go/framework/pkg/http"
    "github.com/stanza-go/framework/pkg/metrics"
)

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

func Register(group *shttp.Group, store *metrics.Store) {
    group.HandleFunc("POST /metrics", recordHandler(store))
}
```

In `main.go`, create a rate-limited sub-group:

```go
// 60 requests/minute for client metrics — separate from auth rate limiting.
clientMetricsRL := api.Group("", http.RateLimit(60, time.Minute))
clientmetrics.Register(clientMetricsRL, store)
```

The handler validates input, auto-prefixes names with `client_`, and records each metric:

```go
func recordHandler(store *metrics.Store) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        // Limit body size.
        r.Body = http.MaxBytesReader(w, r.Body, 64*1024)

        var req struct {
            Name    string            `json:"name"`
            Value   float64           `json:"value"`
            Labels  map[string]string `json:"labels"`
            Metrics []struct {
                Name   string            `json:"name"`
                Value  float64           `json:"value"`
                Labels map[string]string `json:"labels"`
            } `json:"metrics"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
            shttp.WriteError(w, shttp.StatusBadRequest, "invalid JSON")
            return
        }

        // Build list of metrics to record.
        type entry struct {
            name   string
            value  float64
            labels map[string]string
        }
        var entries []entry
        if len(req.Metrics) > 0 {
            entries = make([]entry, len(req.Metrics))
            for i, m := range req.Metrics {
                entries[i] = entry{m.Name, m.Value, m.Labels}
            }
        } else if req.Name != "" {
            entries = []entry{{req.Name, req.Value, req.Labels}}
        }

        if len(entries) == 0 {
            shttp.WriteError(w, shttp.StatusBadRequest, "no metrics provided")
            return
        }
        if len(entries) > 20 {
            shttp.WriteError(w, shttp.StatusBadRequest, "max 20 metrics per request")
            return
        }

        // Validate and record each metric.
        for _, e := range entries {
            if err := validateEntry(e.name, e.labels); err != nil {
                shttp.WriteError(w, shttp.StatusBadRequest, err.Error())
                return
            }
            // Auto-prefix with client_.
            name := "client_" + e.name
            var labelPairs []string
            for k, v := range e.labels {
                labelPairs = append(labelPairs, k, v)
            }
            store.Record(name, e.value, labelPairs...)
        }

        shttp.WriteJSON(w, shttp.StatusOK, map[string]any{
            "recorded": len(entries),
        })
    }
}
```

{% callout title="Fail-fast validation" %}
The handler validates all entries before recording any. If a batch contains one invalid metric, the entire request is rejected. This prevents partial recording where some metrics are stored and others aren't.
{% /callout %}

---

## Frontend JavaScript

### Basic tracking function

```javascript
async function trackMetric(name, value = 1, labels = {}) {
    try {
        await fetch('/api/metrics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, value, labels }),
        });
    } catch {
        // Silently ignore — analytics should never break the app.
    }
}
```

### Page views

Track page views on load:

```javascript
trackMetric('page_view', 1, {
    page: window.location.pathname,
    referrer: document.referrer || 'direct',
});
```

For single-page apps, track on route change:

```javascript
// React Router example.
useEffect(() => {
    trackMetric('page_view', 1, { page: location.pathname });
}, [location.pathname]);
```

### Click tracking

```javascript
document.querySelectorAll('[data-track]').forEach(el => {
    el.addEventListener('click', () => {
        trackMetric('click', 1, {
            element: el.dataset.track,
            page: window.location.pathname,
        });
    });
});
```

```html
<button data-track="signup_btn">Sign up</button>
<a href="/pricing" data-track="pricing_link">View pricing</a>
```

### Time on page

```javascript
const pageStart = Date.now();
window.addEventListener('beforeunload', () => {
    const duration = Date.now() - pageStart;
    // Use sendBeacon for reliability during page unload.
    navigator.sendBeacon('/api/metrics', JSON.stringify({
        name: 'time_on_page',
        value: duration,
        labels: { page: window.location.pathname },
    }));
});
```

{% callout title="Use sendBeacon for unload events" %}
`fetch` requests during `beforeunload` may be cancelled by the browser. `navigator.sendBeacon` is designed for this — it queues the request and guarantees delivery even as the page is closing.
{% /callout %}

### Batch tracking

Buffer events and send them in batches to reduce network requests:

```javascript
let buffer = [];
let flushTimer = null;

function trackMetric(name, value = 1, labels = {}) {
    buffer.push({ name, value, labels });
    if (buffer.length >= 10) {
        flushMetrics();
    } else if (!flushTimer) {
        flushTimer = setTimeout(flushMetrics, 5000);
    }
}

function flushMetrics() {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, 20);
    clearTimeout(flushTimer);
    flushTimer = null;

    fetch('/api/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metrics: batch }),
    }).catch(() => {});
}

// Flush remaining on page unload.
window.addEventListener('beforeunload', () => {
    if (buffer.length > 0) {
        navigator.sendBeacon('/api/metrics', JSON.stringify({
            metrics: buffer.splice(0, 20),
        }));
    }
});
```

This batches up to 10 events or flushes every 5 seconds, whichever comes first. On page unload, remaining events are sent via `sendBeacon`.

---

## Viewing client metrics in admin

Client metrics appear in the admin metrics explorer alongside system metrics, prefixed with `client_`:

```bash
# List all metric names — client metrics are prefixed.
curl -s -H "Authorization: Bearer $TOKEN" \
    http://localhost:23710/api/admin/metrics/names | jq .
```

```json
{
  "names": [
    "client_click",
    "client_page_view",
    "client_time_on_page",
    "go_goroutines",
    "http_requests",
    "..."
  ]
}
```

```bash
# Query page views in the last 24 hours, summed per hour.
curl -s -H "Authorization: Bearer $TOKEN" \
    "http://localhost:23710/api/admin/metrics/query?name=client_page_view&start=$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)&end=$(date -u +%Y-%m-%dT%H:%M:%SZ)&step=1h&fn=sum" | jq .
```

```bash
# Top clicked elements — count per element label.
curl -s -H "Authorization: Bearer $TOKEN" \
    "http://localhost:23710/api/admin/metrics/query?name=client_click&start=2026-03-23T00:00:00Z&end=2026-03-23T23:59:59Z&step=24h&fn=sum" | jq '.series[] | {element: .labels.element, clicks: .points[0].v}'
```

In the admin panel's metrics explorer, select any `client_*` metric from the picker, choose a time range and aggregation, and the chart renders automatically.

---

## What to track

Good client-side metrics for a typical web app:

| Metric | Value | Labels | Aggregation |
|--------|-------|--------|-------------|
| `page_view` | `1` | `page`, `referrer` | Sum — total views |
| `click` | `1` | `element`, `page` | Sum — click counts |
| `time_on_page` | duration (ms) | `page` | Avg — average session time |
| `form_submit` | `1` | `form`, `result` | Sum — submissions |
| `error` | `1` | `type`, `page` | Sum — frontend errors |
| `api_latency` | duration (ms) | `endpoint` | Avg — perceived API speed |
| `scroll_depth` | percentage (0-100) | `page` | Avg — engagement |

---

## Tips

- **Keep it quiet.** Analytics code should never throw, alert, or break the user experience. Wrap all tracking in try/catch or `.catch(() => {})`.
- **Use `sendBeacon` for exit events.** Page unload, tab close, and navigation away — `fetch` may be cancelled, `sendBeacon` won't.
- **Batch when possible.** Each HTTP request has overhead. Buffering 5-10 events before flushing reduces load on both client and server.
- **Don't track PII.** Metric labels are stored in plain text. Never put emails, names, phone numbers, or session tokens in labels.
- **Bounded label values.** Use page paths, button names, form names — not free-text user input. Unbounded values create series explosion in the metrics store.
- **30-day retention.** Client metrics are pruned automatically after 30 days (the store's default retention). For longer retention, adjust `WithRetention` on the store — but more data means more disk usage.

See the [Metrics](/metrics) reference for the full store API, and the [Application Metrics](/recipes/application-metrics) recipe for server-side instrumentation.
