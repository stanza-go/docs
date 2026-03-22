---
title: Logging
nextjs:
  metadata:
    title: Logging
    description: Structured JSON logging with levels, typed fields, child loggers, and file rotation.
---

The `pkg/log` package provides structured JSON logging. Every log entry is a JSON object with a timestamp, level, message, and optional fields.

```go
import "github.com/stanza-go/framework/pkg/log"
```

---

## Creating a logger

```go
logger := log.New(
    log.WithLevel(log.LevelInfo),       // minimum level (default: Info)
    log.WithWriter(os.Stdout),          // output destination (default: Stdout)
    log.WithFields(log.String("app", "stanza")), // fields on every entry
)
```

---

## Log levels

Four levels in ascending severity:

```go
logger.Debug("cache hit", log.String("key", "user:42"))
logger.Info("request handled", log.Int("status", 200), log.Duration("latency", elapsed))
logger.Warn("slow query", log.Duration("duration", d), log.String("query", sql))
logger.Error("failed to connect", log.Err(err))
```

Entries below the configured level are discarded. Parse levels from strings:

```go
level := log.ParseLevel("debug")  // LevelDebug
level := log.ParseLevel("info")   // LevelInfo
level := log.ParseLevel("warn")   // LevelWarn
level := log.ParseLevel("error")  // LevelError
level := log.ParseLevel("unknown") // LevelInfo (default)
```

---

## Fields

Fields are typed key-value pairs. Use the constructor functions for type safety:

```go
log.String("key", "value")
log.Int("count", 42)
log.Int64("id", 1234567890)
log.Float64("rate", 0.95)
log.Bool("active", true)
log.Err(err)                            // key is always "error"
log.Duration("latency", 150*time.Millisecond)
log.Time("started_at", time.Now())       // RFC3339 in UTC
log.Any("data", someStruct)              // arbitrary value
```

---

## Child loggers

Create loggers with pre-set fields using `With`:

```go
reqLogger := logger.With(
    log.String("request_id", requestID),
    log.String("method", r.Method),
    log.String("path", r.URL.Path),
)

reqLogger.Info("handling request")
// output includes request_id, method, path on every entry
```

Child loggers share the parent's writer and mutex, so writes are serialized.

---

## Request-scoped logging

Store a logger in a request's context so that handler-level log entries automatically include the request ID:

```go
// NewContext stores a logger in a context.
ctx = log.NewContext(ctx, logger)

// FromContext retrieves it. Returns nil if no logger is present.
l := log.FromContext(ctx)
```

The `http.RequestLogger` middleware does this automatically — it creates a child logger with the `request_id` field and stores it in the request context. Handlers retrieve it with `log.FromContext`:

```go
func createUser(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        l := log.FromContext(r.Context())

        // Every log entry from l includes {"request_id":"..."}
        l.Error("create user failed", log.Err(err))
    }
}
```

This correlates handler errors with the specific HTTP request in the logs — essential for production debugging.

---

## File rotation

Write logs to files with automatic rotation by date or size:

```go
fw, err := log.NewFileWriter("/var/log/myapp",
    log.WithMaxSize(100 * 1024 * 1024),  // 100MB per file (default)
    log.WithMaxFiles(7),                   // keep 7 rotated files (default)
)
if err != nil {
    return err
}
defer fw.Close()

logger := log.New(
    log.WithWriter(fw),
    log.WithLevel(log.LevelInfo),
)
```

Rotation triggers when the date changes (UTC) or the file exceeds `maxSize`. Old files are pruned to keep at most `maxFiles`.

---

## Multiple outputs

Write to both stdout and a file using `io.MultiWriter`:

```go
fw, _ := log.NewFileWriter(logDir)
writer := io.MultiWriter(os.Stdout, fw)

logger := log.New(log.WithWriter(writer))
```

---

## Output format

Every entry is a single JSON line:

```json
{"time":"2026-03-21T10:30:00Z","level":"info","msg":"request handled","method":"GET","path":"/api/health","status":200,"duration":"1.2ms"}
```

Fields from the logger, child logger, and individual log call are merged. The `time`, `level`, and `msg` keys are always present.

---

## In a Stanza app

```go
func provideLogger(lc *lifecycle.Lifecycle, dir *datadir.Dir, cfg *config.Config) *log.Logger {
    fw, _ := log.NewFileWriter(dir.Path("logs"))

    lc.Append(lifecycle.Hook{
        OnStop: func(ctx context.Context) error {
            return fw.Close()
        },
    })

    return log.New(
        log.WithLevel(log.ParseLevel(cfg.GetString("log.level"))),
        log.WithWriter(io.MultiWriter(os.Stdout, fw)),
    )
}
```
