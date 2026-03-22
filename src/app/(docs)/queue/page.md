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
    queue.WithDefaultTimeout(5 * time.Minute), // max execution time per job (default: 0 = no timeout)
    queue.WithLogger(logger),
)
```

| Option | Default | Description |
|--------|---------|-------------|
| `WithWorkers(n)` | `1` | Number of concurrent worker goroutines |
| `WithPollInterval(d)` | `1s` | How frequently workers check for new jobs |
| `WithMaxAttempts(n)` | `3` | Default maximum retry count |
| `WithRetryDelay(d)` | `30s` | Base delay between retries (multiplied by attempt number) |
| `WithDefaultTimeout(d)` | `0` (none) | Maximum execution time per job before context cancellation |
| `WithLogger(l)` | `nil` | Logger for queue events |

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

// Enqueue with a per-job timeout (overrides default)
jobID, err := q.Enqueue(ctx, "generate-report", payload,
    queue.Timeout(10 * time.Minute),
)

// Enqueue with timeout explicitly disabled (even if default is set)
jobID, err := q.Enqueue(ctx, "send-email", payload,
    queue.Timeout(0),
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

## Timeouts

Jobs can have a maximum execution time. If a handler does not complete within the timeout, its context is cancelled and the job fails with a timeout error. Timed-out jobs follow the normal retry flow — they are retried if attempts remain, or moved to `dead` if exhausted.

Set a default timeout for all jobs on the queue:

```go
q := queue.New(db, queue.WithDefaultTimeout(5 * time.Minute))
```

Override the default for specific jobs at enqueue time:

```go
// Long-running report gets 30 minutes
q.Enqueue(ctx, "generate-report", payload, queue.Timeout(30 * time.Minute))

// Quick notification gets 30 seconds
q.Enqueue(ctx, "send-notification", payload, queue.Timeout(30 * time.Second))

// Explicitly disable timeout for this job (even if default is set)
q.Enqueue(ctx, "stream-import", payload, queue.Timeout(0))
```

The timeout is stored per-job in the database and survives process restarts. Handlers should check `ctx.Done()` to detect cancellation — the context is cancelled when the timeout expires, when the queue is stopping, or when `Cancel(id)` is called.

```go
q.Register("generate-report", func(ctx context.Context, payload []byte) error {
    for _, batch := range batches {
        select {
        case <-ctx.Done():
            return ctx.Err() // timeout, shutdown, or cancel
        default:
        }
        processBatch(batch)
    }
    return nil
})
```

The `Job.Timeout` field reports the configured timeout as a `time.Duration`. Zero means no timeout.

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

### Count jobs

`JobCount` returns the total number of jobs matching a filter, ignoring `Limit` and `Offset`. Useful for pagination totals:

```go
total, err := q.JobCount(queue.Filter{
    Status: queue.StatusFailed,
})
```

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
