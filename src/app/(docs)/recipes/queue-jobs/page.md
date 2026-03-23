---
title: Queue jobs
nextjs:
  metadata:
    title: Queue jobs
    description: How to create background jobs with retries, delays, and monitoring.
---

The job queue runs in-process with SQLite-backed persistence. Jobs survive restarts, retry on failure, and are observable through the admin panel. This recipe shows how to add a custom job type.

---

## Where queue handlers live

Queue handlers are registered in the `provideQueue` function in `api/main.go`:

```go
func provideQueue(lc *lifecycle.Lifecycle, db *sqlite.DB, logger *log.Logger) (*queue.Queue, error) {
    q := queue.New(db,
        queue.WithWorkers(2),
        queue.WithLogger(logger),
    )

    // register handlers here

    lc.Append(lifecycle.Hook{
        OnStart: q.Start,
        OnStop:  q.Stop,
    })

    return q, nil
}
```

---

## Step 1: Define the payload

Each job type has a JSON payload. Define a struct for it:

```go
type WelcomeEmailPayload struct {
    UserID int64  `json:"user_id"`
    Email  string `json:"email"`
    Name   string `json:"name"`
}
```

---

## Step 2: Register the handler

Add a `q.Register()` call inside `provideQueue`:

```go
q.Register("send-welcome-email", func(ctx context.Context, payload []byte) error {
    var p WelcomeEmailPayload
    if err := json.Unmarshal(payload, &p); err != nil {
        return fmt.Errorf("unmarshal payload: %w", err)
    }

    logger.Info("sending welcome email",
        log.Int64("user_id", p.UserID),
        log.String("email", p.Email),
    )

    // Do the actual work — send an email, call an API, etc.
    // Return an error to trigger a retry.
    return nil
})
```

If the handler returns an error, the job is retried with linear backoff. After all attempts are exhausted, it moves to `dead` status.

---

## Step 3: Enqueue from a handler

In any module where you need to dispatch work, inject the queue and enqueue:

```go
// In your module's Register function:
func Register(admin *http.Group, db *sqlite.DB, q *queue.Queue) {
    admin.HandleFunc("POST /users", createHandler(db, q))
}

func createHandler(db *sqlite.DB, q *queue.Queue) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        // ... create user in database ...

        // Enqueue welcome email (fire-and-forget)
        payload, _ := json.Marshal(WelcomeEmailPayload{
            UserID: result.LastInsertID,
            Email:  req.Email,
            Name:   req.Name,
        })
        _, _ = q.Enqueue(r.Context(), "send-welcome-email", payload)

        http.WriteJSON(w, http.StatusCreated, map[string]any{"user": user})
    }
}
```

---

## Enqueue options

```go
// Run after a delay
_, err := q.Enqueue(ctx, "send-welcome-email", payload,
    queue.Delay(5 * time.Minute),
)

// Override max retry attempts
_, err := q.Enqueue(ctx, "send-welcome-email", payload,
    queue.MaxAttempts(5),
)

// Route to a specific named queue
_, err := q.Enqueue(ctx, "generate-report", payload,
    queue.OnQueue("reports"),
)
```

---

## Job lifecycle

```
pending → running → completed
                  → failed (retries remaining → pending)
                  → failed (no retries → dead)
pending → cancelled
```

| Status | Meaning |
|--------|---------|
| `pending` | Waiting for a worker |
| `running` | Being processed |
| `completed` | Finished successfully |
| `failed` | Handler returned an error |
| `dead` | All retry attempts exhausted |
| `cancelled` | Cancelled via admin API |

---

## Monitoring

The admin panel provides a full queue dashboard at `/admin/queue`:

- Filter by status, type, and queue name
- View job details — payload, attempts, error output, timing
- Retry dead jobs (single or bulk)
- Cancel pending jobs
- Stats: pending, running, completed, failed, dead counts

The admin API endpoints:

```
GET  /api/admin/queue/stats               — counts by status
GET  /api/admin/queue/jobs?status=X&type=X — filtered job list
GET  /api/admin/queue/jobs/{id}           — single job detail
POST /api/admin/queue/jobs/{id}/retry     — retry a failed/dead job
POST /api/admin/queue/jobs/{id}/cancel    — cancel a pending job
```

---

## Tips

- **Handlers must be registered before `q.Start()`.** Add them in `provideQueue`.
- **Payloads are raw JSON bytes.** You control the structure — the queue doesn't interpret them.
- **Keep handlers idempotent.** Jobs may be retried, so design for safe re-execution.
- **Log outcomes.** Workers run silently in the background. Use the logger to make failures observable.
- **Use cron for periodic enqueuing.** A cron job that enqueues queue work is a common pattern — the cron fires on schedule, the queue handles retries and backpressure. See [Custom cron jobs](/recipes/cron-jobs).
- **Completed jobs are purged.** The built-in `purge-completed-jobs` cron removes completed and cancelled jobs older than 24 hours.
