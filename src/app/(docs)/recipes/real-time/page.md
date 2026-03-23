---
title: Real-time with WebSocket
nextjs:
  metadata:
    title: Real-time with WebSocket
    description: How to build real-time features using the built-in WebSocket support — log streaming, live notifications, and custom event streams.
---

The framework's `pkg/http` package includes a zero-dependency WebSocket implementation (RFC 6455). The standalone app uses it for two real-time features: live log streaming and instant notification delivery. This recipe shows how both work and how to build your own real-time endpoints.

---

## Basic WebSocket endpoint

Register a WebSocket endpoint like any other handler. The `Upgrader` handles the HTTP-to-WebSocket handshake:

```go
upgrader := http.Upgrader{}

func streamHandler(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r)
    if err != nil {
        return // Upgrade writes the error response
    }
    defer conn.Close()

    // Reader goroutine detects client disconnect
    done := make(chan struct{})
    go func() {
        defer close(done)
        for {
            _, _, err := conn.ReadMessage()
            if err != nil {
                return
            }
        }
    }()

    // Send events until disconnect
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-done:
            return
        case <-ticker.C:
            conn.WritePing(nil) // Keep-alive
        }
    }
}
```

The pattern is always the same: upgrade, spawn a reader goroutine to detect disconnection, then loop sending events with periodic pings for keep-alive.

---

## Pattern 1: Log streaming

The admin panel's log viewer streams new log entries in real-time via `GET /api/admin/logs/stream`.

### How it works

1. Opens the current log file and seeks to the end
2. Polls every 300ms for new lines via `bufio.Reader`
3. Parses each line as JSON, applies filters, and sends matching entries
4. Client can update filters mid-stream by sending a JSON message

```go
func streamHandler(logsDir string) func(http.ResponseWriter, *http.Request) {
    upgrader := http.Upgrader{}

    return func(w http.ResponseWriter, r *http.Request) {
        conn, err := upgrader.Upgrade(w, r)
        if err != nil {
            return
        }
        defer conn.Close()

        // Initial filters from query params
        level := r.URL.Query().Get("level")
        search := r.URL.Query().Get("search")

        // Open log file and seek to end
        logPath := filepath.Join(logsDir, "stanza.log")
        f, err := os.Open(logPath)
        if err != nil {
            conn.CloseWithMessage(http.CloseGoingAway, "log file unavailable")
            return
        }
        defer f.Close()
        f.Seek(0, io.SeekEnd)
        reader := bufio.NewReader(f)

        // Reader goroutine — handles disconnection and filter updates
        type filterUpdate struct {
            Level  string `json:"level"`
            Search string `json:"search"`
        }
        filterCh := make(chan filterUpdate, 1)
        done := make(chan struct{})
        go func() {
            defer close(done)
            for {
                _, data, err := conn.ReadMessage()
                if err != nil {
                    return
                }
                var fu filterUpdate
                if json.Unmarshal(data, &fu) == nil {
                    select {
                    case filterCh <- fu:
                    default:
                    }
                }
            }
        }()

        // Tail loop
        poll := time.NewTicker(300 * time.Millisecond)
        defer poll.Stop()
        ping := time.NewTicker(30 * time.Second)
        defer ping.Stop()

        for {
            select {
            case <-done:
                return
            case fu := <-filterCh:
                level = fu.Level
                search = fu.Search
            case <-ping.C:
                conn.WritePing(nil)
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
                    // Apply filters
                    if level != "" {
                        if entryLevel, _ := entry["level"].(string); entryLevel != level {
                            continue
                        }
                    }
                    if search != "" && !matchesSearch(entry, search) {
                        continue
                    }
                    conn.WriteMessage(http.TextMessage, []byte(strings.TrimSpace(line)))
                }
            }
        }
    }
}
```

### Why 300ms polling instead of fsnotify

Polling at 300ms is simpler and more reliable than file system notifications. It works on all operating systems including containers, has zero external dependencies, and the latency is imperceptible for log tailing. The CPU cost is negligible — it's a single `ReadString` call that returns immediately when there's nothing new.

### Client-side filter updates

The client can change filters without reconnecting by sending a JSON message:

```json
{"level": "error", "search": "timeout"}
```

The server picks up the update on the next poll cycle. This avoids the overhead of tearing down and re-establishing the WebSocket connection.

---

## Pattern 2: Notification pub/sub

Admin notifications are delivered instantly via `GET /api/admin/notifications/stream`. This uses an in-memory pub/sub Hub.

### The Hub

```go
type Event struct {
    Type         string        `json:"type"`
    Notification *Notification `json:"notification,omitempty"`
    UnreadCount  int           `json:"unread_count"`
}

type Hub struct {
    mu          sync.Mutex
    subscribers map[int64][]*subscriber
}

type subscriber struct {
    ch chan Event
}

func NewHub() *Hub {
    return &Hub{subscribers: make(map[int64][]*subscriber)}
}
```

- `Subscribe(adminID)` — returns a receive-only event channel and an unsubscribe function
- `Publish(adminID, event)` — sends to all subscribers for that admin (non-blocking)
- `PublishAll(event)` — broadcasts to every connected subscriber

The channel is buffered at 16 events. Sends are non-blocking — if a subscriber's buffer is full, the event is dropped rather than blocking the publisher.

### Publishing on notification creation

The `Service.NotifyAdmin` method automatically publishes to the Hub after inserting the notification:

```go
func (s *Service) NotifyAdmin(adminID int64, notifType, title, message string, opts ...Option) {
    // Insert notification into database
    notifications.Notify(s.db, EntityAdmin, fmt.Sprintf("%d", adminID),
        notifType, title, message, "")

    // Publish to WebSocket subscribers
    count := notifications.UnreadCount(s.db, EntityAdmin, fmt.Sprintf("%d", adminID))
    s.hub.Publish(adminID, Event{
        Type:        "notification",
        Notification: &Notification{/* ... */},
        UnreadCount: count,
    })
}
```

### WebSocket stream endpoint

```go
func streamHandler(svc *notifications.Service) func(http.ResponseWriter, *http.Request) {
    upgrader := http.Upgrader{}

    return func(w http.ResponseWriter, r *http.Request) {
        conn, err := upgrader.Upgrade(w, r)
        if err != nil {
            return
        }
        defer conn.Close()

        adminID := getAdminID(r) // From JWT middleware

        // Subscribe to events for this admin
        events, unsub := svc.Hub().Subscribe(adminID)
        defer unsub()

        // Send initial unread count
        count := notifications.UnreadCount(svc.DB(), "admin", fmt.Sprintf("%d", adminID))
        initial, _ := json.Marshal(Event{Type: "unread_count", UnreadCount: count})
        conn.WriteMessage(http.TextMessage, initial)

        // Reader goroutine
        done := make(chan struct{})
        go func() {
            defer close(done)
            for {
                _, _, err := conn.ReadMessage()
                if err != nil {
                    return
                }
            }
        }()

        // Stream events
        ping := time.NewTicker(30 * time.Second)
        defer ping.Stop()

        for {
            select {
            case <-done:
                return
            case evt := <-events:
                data, _ := json.Marshal(evt)
                conn.WriteMessage(http.TextMessage, data)
            case <-ping.C:
                conn.WritePing(nil)
            }
        }
    }
}
```

### Event types

The stream sends two types of events:

| Event type | When | Payload |
|------------|------|---------|
| `unread_count` | On initial connection | `{"type":"unread_count","unread_count":3}` |
| `notification` | When a notification is created | `{"type":"notification","notification":{...},"unread_count":4}` |

Each event includes the updated `unread_count` so the client never needs a separate HTTP call to stay in sync.

---

## Pattern 3: Chat room

A chat room demonstrates true bidirectional messaging — clients send messages that are broadcast to everyone in the room. This pattern applies to any multi-user interactive feature (collaborative editing, live comments, game lobbies).

### Message protocol

Define explicit message types for both directions:

```go
// Client → server
type clientMsg struct {
    Type string `json:"type"` // "join", "message"
    Name string `json:"name,omitempty"`
    Text string `json:"text,omitempty"`
}

// Server → client
type serverMsg struct {
    Type   string `json:"type"` // "joined", "left", "message", "members"
    Name   string `json:"name,omitempty"`
    Text   string `json:"text,omitempty"`
    Count  int    `json:"count,omitempty"`
}
```

### Room with broadcast

```go
type Room struct {
    mu      sync.Mutex
    members map[*http.Conn]string // conn → name
}

func NewRoom() *Room {
    return &Room{members: make(map[*http.Conn]string)}
}

func (r *Room) Join(conn *http.Conn, name string) {
    r.mu.Lock()
    r.members[conn] = name
    count := len(r.members)
    r.mu.Unlock()

    r.broadcast(serverMsg{Type: "joined", Name: name, Count: count})
}

func (r *Room) Leave(conn *http.Conn) {
    r.mu.Lock()
    name := r.members[conn]
    delete(r.members, conn)
    count := len(r.members)
    r.mu.Unlock()

    if name != "" {
        r.broadcast(serverMsg{Type: "left", Name: name, Count: count})
    }
}

func (r *Room) Broadcast(name, text string) {
    r.broadcast(serverMsg{Type: "message", Name: name, Text: text})
}

func (r *Room) broadcast(msg serverMsg) {
    data, _ := json.Marshal(msg)

    r.mu.Lock()
    targets := make([]*http.Conn, 0, len(r.members))
    for conn := range r.members {
        targets = append(targets, conn)
    }
    r.mu.Unlock()

    // Write outside the lock to avoid blocking other operations.
    for _, conn := range targets {
        _ = conn.WriteMessage(http.TextMessage, data)
    }
}
```

{% callout title="Write outside the lock" %}
Collect connections under the lock, then write after releasing it. Network writes can block or be slow — holding the mutex during writes would block joins, leaves, and other broadcasts.
{% /callout %}

### WebSocket handler

```go
func chatHandler(room *Room) func(http.ResponseWriter, *http.Request) {
    upgrader := http.Upgrader{}

    return func(w http.ResponseWriter, r *http.Request) {
        conn, err := upgrader.Upgrade(w, r)
        if err != nil {
            return
        }
        defer conn.Close()

        conn.SetMaxMessageSize(4096)

        // First message must be a join.
        _, data, err := conn.ReadMessage()
        if err != nil {
            return
        }
        var join clientMsg
        if json.Unmarshal(data, &join) != nil || join.Type != "join" {
            return
        }
        name := join.Name
        if name == "" {
            name = "Anonymous"
        }
        if len(name) > 30 {
            name = name[:30]
        }

        room.Join(conn, name)
        defer room.Leave(conn)

        // Read loop — process messages until disconnect.
        for {
            _, data, err := conn.ReadMessage()
            if err != nil {
                return
            }
            var msg clientMsg
            if json.Unmarshal(data, &msg) != nil {
                continue
            }
            if msg.Type == "message" && msg.Text != "" {
                if len(msg.Text) > 500 {
                    msg.Text = msg.Text[:500]
                }
                room.Broadcast(name, msg.Text)
            }
        }
    }
}
```

Register the endpoint:

```go
room := NewRoom()
api.HandleFunc("GET /chat/ws", chatHandler(room))
```

### Key differences from server-push patterns

| | Log streaming / Notifications | Chat room / Game |
|---|---|---|
| **Flow** | Mostly server → client | Bidirectional |
| **Reader goroutine** | Detects disconnection (or filter updates) | Processes client commands |
| **Shared state** | Per-user (Hub subscriber) | Multi-user (Room, Game) |
| **First message** | Optional | Join/handshake required |
| **Broadcast** | To one subscriber | To all members |

---

## Client-side patterns

### Basic WebSocket client

```js
const ws = new WebSocket(`ws://${location.host}/api/chat/ws`)

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'join', name: 'Alice' }))
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  switch (msg.type) {
    case 'joined':
      console.log(`${msg.name} joined (${msg.count} online)`)
      break
    case 'message':
      console.log(`${msg.name}: ${msg.text}`)
      break
    case 'left':
      console.log(`${msg.name} left`)
      break
  }
}

ws.onclose = () => console.log('Disconnected')
ws.onerror = () => console.log('Connection error')
```

### Auto-reconnecting client

WebSocket has no built-in reconnection (unlike SSE's `EventSource`). Implement it manually:

```js
function connectWebSocket(url, { onMessage, onConnect, onDisconnect }) {
  let ws
  let reconnectTimer

  function connect() {
    ws = new WebSocket(url)

    ws.onopen = () => {
      if (onConnect) onConnect(ws)
    }

    ws.onmessage = (event) => {
      onMessage(JSON.parse(event.data))
    }

    ws.onclose = () => {
      if (onDisconnect) onDisconnect()
      reconnectTimer = setTimeout(connect, 3000)
    }

    ws.onerror = () => ws.close()
  }

  connect()

  // Return cleanup function (for React useEffect, etc.)
  return () => {
    clearTimeout(reconnectTimer)
    ws.close()
  }
}
```

Usage:

```js
const cleanup = connectWebSocket(`ws://${location.host}/api/chat/ws`, {
  onConnect: (ws) => ws.send(JSON.stringify({ type: 'join', name: 'Alice' })),
  onMessage: (msg) => appendMessage(msg),
  onDisconnect: () => showReconnecting(),
})

// Cleanup on unmount
cleanup()
```

### React hook

```js
function useWebSocket(url, onMessage) {
  const wsRef = useRef(null)

  useEffect(() => {
    let reconnectTimer
    let mounted = true

    function connect() {
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onmessage = (event) => onMessage(JSON.parse(event.data))
      ws.onclose = () => {
        if (mounted) reconnectTimer = setTimeout(connect, 3000)
      }
      ws.onerror = () => ws.close()
    }

    connect()
    return () => {
      mounted = false
      clearTimeout(reconnectTimer)
      wsRef.current?.close()
    }
  }, [url])

  const send = useCallback((data) => {
    wsRef.current?.send(JSON.stringify(data))
  }, [])

  return send
}
```

### With authentication

WebSocket connections carry cookies automatically. Since Stanza stores JWT access tokens in `HttpOnly` cookies, authentication works without extra setup:

```js
// Cookies are sent with the upgrade request — no extra headers needed.
const ws = new WebSocket(`ws://${location.host}/api/chat/ws`)
```

Protect the WebSocket endpoint with the same auth middleware as your HTTP routes. The middleware runs on the initial HTTP request before the upgrade.

---

## Vite proxy for WebSocket

During development, the Vite dev server proxies `/api/*` to the Go backend. WebSocket connections need `ws: true` in the proxy config — without it, the upgrade handshake fails with a 404.

```js
// vite.config.js
export default defineConfig({
  server: {
    port: 23700,
    proxy: {
      "/api": {
        target: "http://localhost:23710",
        changeOrigin: true,
        ws: true, // Required for WebSocket
      },
    },
  },
})
```

{% callout title="Don't forget ws: true" type="warning" %}
The default Vite proxy config in the standalone `ui/` project does not include `ws: true`. If your app uses WebSocket, add it. The `admin/` project already has it enabled (for log streaming and notifications). In production, this is not needed — the embedded binary serves everything directly.
{% /callout %}

---

## Building your own real-time endpoint

Follow this checklist when adding a new WebSocket endpoint:

1. **Create the upgrader** — default `http.Upgrader{}` works for same-origin. Set `CheckOrigin` if you need cross-origin WebSocket.

2. **Authenticate** — protect the endpoint with the same middleware as your HTTP routes. JWT authentication happens on the initial HTTP request before the upgrade.

3. **Reader goroutine** — always spawn one. Even if you don't expect client messages, the reader detects disconnection. Close a `done` channel when it returns.

4. **Ping heartbeat** — send a ping every 30 seconds. Without it, dead connections (client crashed, network dropped) won't be detected until the next write fails.

5. **Non-blocking sends** — if your event source can outpace the client, use a buffered channel with `select { case ch <- event: default: }` to drop events rather than blocking.

6. **Clean shutdown** — defer `conn.Close()` and `unsub()` (if using pub/sub). The deferred close sends a close frame to the client.

---

## Admin panel integration

### Notification bell

The notification bell connects via WebSocket on mount:

- Receives real-time events and updates the unread badge instantly
- Falls back to 30-second HTTP polling when WebSocket fails
- Auto-reconnects after 5 seconds on disconnect
- Reconnects when the tab becomes visible after being hidden
- Shows a Wifi/WifiOff indicator for connection status

### Log viewer

The log viewer uses WebSocket for the current log file:

- "Live" mode streams new entries via WebSocket
- Falls back to HTTP polling for rotated log files
- Shows a streaming status indicator (connected/connecting/disconnected)
- Filter changes are sent to the server mid-stream without reconnecting
- Caps display at 500 entries to prevent memory growth

---

## Tips

- **300ms polling for file tailing.** Simpler and more portable than `fsnotify`. The latency is not noticeable for log streaming.
- **Hub lives on the Service, not globally.** The notification Hub is created inside `NewService()` and accessed via `svc.Hub()`. This keeps it testable and avoids global state.
- **Buffer size of 16.** The subscriber channel buffer (16 events) handles normal bursts. If notifications arrive faster than the WebSocket can flush, events are dropped — this is intentional. The client can always fetch missed notifications via the HTTP API.
- **One reader + one writer.** The framework's `Conn` is safe for exactly this pattern. Don't share a `Conn` across multiple writer goroutines without your own mutex.
- **Middleware chain compatibility.** The framework's middleware wrappers all implement `Unwrap()`, so WebSocket upgrade works through any middleware stack. No special ordering needed.
