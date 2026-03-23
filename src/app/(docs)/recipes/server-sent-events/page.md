---
title: Server-Sent Events (SSE)
nextjs:
  metadata:
    title: Server-Sent Events (SSE)
    description: How to stream server-to-client events using the built-in SSE support — log tailing, notification feeds, and live dashboards.
---

The framework's `pkg/http` package includes an `SSEWriter` for streaming server-to-client events over plain HTTP. SSE is simpler than WebSocket when you only need one-way data flow — the server pushes events and the browser's `EventSource` API handles reconnection automatically. The standalone app uses SSE for its log streaming endpoint alongside the existing WebSocket version.

---

## When to use SSE vs WebSocket

| | SSE | WebSocket |
|---|---|---|
| **Direction** | Server → client only | Bidirectional |
| **Protocol** | Plain HTTP | Upgraded connection |
| **Reconnection** | Automatic (built into EventSource) | Manual (you write reconnect logic) |
| **Data format** | Text (UTF-8) | Text or binary |
| **Best for** | Log streaming, notifications, dashboards | Chat, interactive updates, mid-stream filter changes |

Use SSE when the client only needs to receive events. Use WebSocket when the client also needs to send messages (like updating filters mid-stream without reconnecting).

---

## Basic SSE endpoint

Create an `SSEWriter` at the start of your handler. Send events in a loop until the client disconnects, detected via `r.Context().Done()`:

```go
func eventsHandler(w http.ResponseWriter, r *http.Request) {
    sse := http.NewSSEWriter(w)

    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    heartbeat := time.NewTicker(30 * time.Second)
    defer heartbeat.Stop()

    for {
        select {
        case <-r.Context().Done():
            return
        case <-ticker.C:
            sse.Event("update", `{"status":"ok"}`)
        case <-heartbeat.C:
            sse.Comment("keepalive")
        }
    }
}
```

`NewSSEWriter` sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `Connection: keep-alive`, then flushes headers immediately. Every `Event`, `Data`, and `Comment` call auto-flushes.

---

## SSEWriter methods

| Method | SSE output | Use case |
|---|---|---|
| `Event(name, data)` | `event: name\ndata: data\n\n` | Named events the client listens for |
| `Data(data)` | `data: data\n\n` | Default "message" events |
| `Comment(text)` | `: text\n` | Keep-alive heartbeats (invisible to EventSource) |
| `Retry(ms)` | `retry: ms\n\n` | Override client reconnection interval |

Multiline data is automatically split across multiple `data:` fields per the SSE spec.

---

## Pattern 1: Log streaming

The standalone app streams log entries via `GET /api/admin/logs/sse`. Filters are passed as query parameters since SSE is server-to-client only.

```go
func sseHandler(logsDir string) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        level := r.URL.Query().Get("level")
        search := r.URL.Query().Get("search")

        // Open log file and seek to end
        f, err := os.Open(filepath.Join(logsDir, "stanza.log"))
        if err != nil {
            http.WriteError(w, http.StatusNotFound, "log file not available")
            return
        }
        defer f.Close()
        f.Seek(0, io.SeekEnd)
        reader := bufio.NewReader(f)

        sse := http.NewSSEWriter(w)
        sse.Retry(5000) // Reconnect after 5 seconds

        poll := time.NewTicker(300 * time.Millisecond)
        defer poll.Stop()
        heartbeat := time.NewTicker(30 * time.Second)
        defer heartbeat.Stop()

        for {
            select {
            case <-r.Context().Done():
                return
            case <-heartbeat.C:
                sse.Comment("keepalive")
            case <-poll.C:
                for {
                    line, err := reader.ReadString('\n')
                    if err != nil {
                        break
                    }
                    var entry map[string]any
                    if json.Unmarshal([]byte(line), &entry) != nil {
                        continue
                    }
                    if level != "" {
                        if entryLevel, _ := entry["level"].(string); entryLevel != level {
                            continue
                        }
                    }
                    sse.Event("log", strings.TrimSpace(line))
                }
            }
        }
    }
}
```

### How it compares to the WebSocket version

The standalone app has both `GET /api/admin/logs/stream` (WebSocket) and `GET /api/admin/logs/sse` (SSE) for the same log data. The WebSocket version supports mid-stream filter updates — the client sends a JSON message to change level/search without reconnecting. The SSE version accepts filters as query parameters, so changing filters requires a new connection. EventSource handles this transparently:

```js
// Changing filters — just create a new EventSource
source.close()
source = new EventSource(`/api/admin/logs/sse?level=error&search=timeout`)
```

For log tailing where filter changes are infrequent, the simpler SSE approach works well.

---

## Pattern 2: Notification feed

SSE is a natural fit for notification delivery — the server pushes new notifications and the client displays them.

```go
func notificationSSE(svc *notifications.Service) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        adminID := getAdminID(r)

        events, unsub := svc.Hub().Subscribe(adminID)
        defer unsub()

        sse := http.NewSSEWriter(w)
        sse.Retry(5000)

        // Send initial unread count
        count := svc.UnreadCount(adminID)
        data, _ := json.Marshal(map[string]any{
            "type":         "unread_count",
            "unread_count": count,
        })
        sse.Event("notification", string(data))

        heartbeat := time.NewTicker(30 * time.Second)
        defer heartbeat.Stop()

        for {
            select {
            case <-r.Context().Done():
                return
            case evt := <-events:
                data, _ := json.Marshal(evt)
                sse.Event("notification", string(data))
            case <-heartbeat.C:
                sse.Comment("keepalive")
            }
        }
    }
}
```

The `Hub` pattern is the same as in the [Real-time with WebSocket](/recipes/real-time) recipe. SSE simplifies the handler — no upgrade, no reader goroutine, no ping frames.

---

## Pattern 3: Dashboard metrics

Push live dashboard stats to the admin panel at a fixed interval:

```go
func dashboardSSE(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        sse := http.NewSSEWriter(w)
        sse.Retry(10000)

        ticker := time.NewTicker(5 * time.Second)
        defer ticker.Stop()

        heartbeat := time.NewTicker(30 * time.Second)
        defer heartbeat.Stop()

        // Send initial snapshot immediately
        sendDashboardEvent(sse, db)

        for {
            select {
            case <-r.Context().Done():
                return
            case <-ticker.C:
                sendDashboardEvent(sse, db)
            case <-heartbeat.C:
                sse.Comment("keepalive")
            }
        }
    }
}

func sendDashboardEvent(sse *http.SSEWriter, db *sqlite.DB) {
    stats := map[string]any{
        "active_sessions": countActiveSessions(db),
        "queued_jobs":     countQueuedJobs(db),
        "failed_jobs_24h": countFailedJobs24h(db),
        "db_size":         db.Stats().FileSize,
    }
    data, _ := json.Marshal(stats)
    sse.Event("metrics", string(data))
}
```

The client receives a `metrics` event every 5 seconds with the latest numbers — no polling logic needed on the frontend.

---

## Client-side patterns

### Basic EventSource

```js
const source = new EventSource('/api/admin/logs/sse?level=error')

source.addEventListener('log', (event) => {
  const entry = JSON.parse(event.data)
  appendLogEntry(entry)
})

source.onerror = () => {
  // EventSource reconnects automatically after the retry interval.
  // Use this handler for UI feedback (show "reconnecting..." indicator).
}
```

### With authentication

EventSource sends cookies automatically, so JWT access tokens in `HttpOnly` cookies work without any extra setup. For custom headers (like API keys), use `fetch` with a readable stream instead:

```js
async function streamSSE(url, onEvent) {
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // Keep incomplete line in buffer

    let eventName = 'message'
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventName = line.slice(7)
      } else if (line.startsWith('data: ')) {
        onEvent(eventName, line.slice(6))
        eventName = 'message'
      }
    }
  }
}
```

### Graceful cleanup

Close the connection when the component unmounts or the page is hidden:

```js
// React cleanup
useEffect(() => {
  const source = new EventSource('/api/admin/logs/sse')
  source.addEventListener('log', handleLog)
  return () => source.close()
}, [])
```

---

## Middleware compatibility

The framework's `Compress` and `ETag` middleware are SSE-aware:

- **Compress** excludes `text/event-stream` from gzip. Gzip buffering would delay event delivery, defeating the purpose of streaming.
- **ETag** switches to passthrough mode when it detects streaming (first `Flush()` call). No ETag is computed for streaming responses.
- Both middleware types implement `http.Flusher`, so `NewSSEWriter` can flush through the full middleware chain.

No special middleware ordering is required. SSE works correctly through any middleware stack.

---

## Tips

- **Always send heartbeats.** A comment every 30 seconds prevents proxies and load balancers from closing idle connections. Cloud providers (Railway, Cloud Run) typically have 60–120 second idle timeouts.
- **Set `Retry` early.** Call `sse.Retry(5000)` immediately after creating the writer to tell the client how long to wait before reconnecting. The default (browser-dependent) is usually 3 seconds.
- **Use named events.** `Event("log", data)` lets the client use `addEventListener('log', ...)` to filter events by type. `Data(data)` fires the generic `onmessage` handler. Named events are cleaner when you have multiple event types.
- **Keep-alive via `Comment`.** SSE comments (`: text\n`) are invisible to `EventSource` but keep the connection alive. This is simpler than WebSocket ping/pong frames.
- **Filters via query params.** Since SSE is server-to-client only, pass filters in the URL. Changing filters means closing and reopening the connection — `EventSource` makes this trivial. For frequent filter changes, prefer the [WebSocket approach](/recipes/real-time).
- **300ms polling for file tailing.** Same as the WebSocket version — simple, portable, negligible CPU cost.
