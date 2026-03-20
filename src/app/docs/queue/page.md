---
title: Job queue
nextjs:
  metadata:
    title: Job queue
    description: SQLite-backed job queue with in-process workers, retries, and monitoring.
---

The `pkg/queue` package provides a durable, SQLite-backed job queue with in-process workers. Jobs survive process restarts because they're stored in the database.

```go
import "github.com/stanza-go/framework/pkg/queue"
```

---

## Creating a queue

```go
q := queue.New(db,
    queue.WithWorkers(2),                      // concurrent workers (default: 1)
    queue.WithPollInterval(1 * time.Second),   // how often workers check for jobs (default: 1s)
    queue.WithMaxAttempts(3),                   // default retry count (default: 3)
    queue.WithRetryDelay(30 * time.Second),    // base delay between retries (default: 30s)
    queue.WithLogger(logger),
)
```

---

## Registering handlers

Register handlers for each job type before starting the queue:

```go
q.Register("send-email", func(ctx context.Context, payload []byte) error {
    var email struct {
        To      string `json:"to"`
        Subject string `json:"subject"`
        Body    string `json:"body"`
    }
    json.Unmarshal(payload, &email)
    return sendEmail(ctx, email.To, email.Subject, email.Body)
})

q.Register("generate-report", func(ctx context.Context, payload []byte) error {
    return generateReport(ctx, payload)
})
```

The context is cancelled when the queue is stopping, allowing handlers to clean up.

---

## Enqueuing jobs

```go
payload, _ := json.Marshal(map[string]string{
    "to":      "user@example.com",
    "subject": "Welcome!",
    "body":    "Thanks for signing up.",
})

// Enqueue immediately
jobID, err := q.Enqueue(ctx, "send-email", payload)

// Enqueue with delay
jobID, err := q.Enqueue(ctx, "send-email", payload,
    queue.Delay(5 * time.Minute),
)

// Enqueue with custom max attempts
jobID, err := q.Enqueue(ctx, "send-email", payload,
    queue.MaxAttempts(5),
)

// Enqueue on a specific named queue
jobID, err := q.Enqueue(ctx, "generate-report", payload,
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
| `pending` | Waiting to be picked up by a worker |
| `running` | Currently being processed |
| `completed` | Finished successfully |
| `failed` | Handler returned an error |
| `dead` | Exhausted all retry attempts |
| `cancelled` | Cancelled before execution |

Failed jobs are automatically retried with linear backoff. After all attempts are exhausted, the job moves to `dead`.

---

## Lifecycle integration

```go
func provideQueue(lc *lifecycle.Lifecycle, db *sqlite.DB, logger *log.Logger) *queue.Queue {
    q := queue.New(db, queue.WithWorkers(2), queue.WithLogger(logger))

    q.Register("send-email", handleSendEmail)
    q.Register("generate-report", handleReport)

    lc.Append(lifecycle.Hook{
        OnStart: q.Start,
        OnStop:  q.Stop,
    })

    return q
}
```

`Start` creates the jobs table if needed and launches worker goroutines. `Stop` signals workers to finish, waits for in-flight jobs, and respects the context deadline.

---

## Monitoring

### Stats

```go
stats, err := q.Stats()
fmt.Printf("pending=%d running=%d completed=%d failed=%d dead=%d\n",
    stats.Pending, stats.Running, stats.Completed, stats.Failed, stats.Dead)
```

### List jobs

```go
jobs, err := q.Jobs(queue.Filter{
    Status: queue.StatusFailed,
    Limit:  20,
    Offset: 0,
})

for _, j := range jobs {
    fmt.Printf("[%d] %s — %s (attempts: %d/%d)\n",
        j.ID, j.Type, j.Status, j.Attempts, j.MaxAttempts)
}
```

Filter by queue name, job type, or status. Default limit is 50.

### Get a single job

```go
job, err := q.Job(42)
fmt.Printf("type=%s status=%s error=%s\n", job.Type, job.Status, job.LastError)
```

---

## Management

### Retry a failed job

```go
err := q.Retry(42)
// Resets status to pending, increments max_attempts by 1
```

Works on both `failed` and `dead` jobs.

### Cancel a pending job

```go
err := q.Cancel(42)
// Only works on pending jobs
```

### Purge old jobs

```go
deleted, err := q.Purge(24 * time.Hour)
// Deletes completed and cancelled jobs older than 24 hours
```

Typically called from a cron job to keep the table clean.
