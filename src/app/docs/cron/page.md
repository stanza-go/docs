---
title: Cron scheduler
nextjs:
  metadata:
    title: Cron scheduler
    description: In-process cron scheduler with standard 5-field expressions and job management.
---

The `pkg/cron` package provides an in-process cron scheduler. Jobs are registered with standard 5-field cron expressions and run in goroutines within the same process.

```go
import "github.com/stanza-go/framework/pkg/cron"
```

---

## Creating a scheduler

```go
scheduler := cron.NewScheduler(
    cron.WithLocation(time.UTC),    // timezone for schedule evaluation (default: UTC)
    cron.WithLogger(logger),        // optional logger
)
```

---

## Adding jobs

Register jobs before starting the scheduler. Each job has a unique name, a cron expression, and a function:

```go
scheduler.Add("cleanup-sessions", "0 * * * *", func(ctx context.Context) error {
    // runs every hour at minute 0
    _, err := db.Exec("DELETE FROM sessions WHERE expires_at < ?", time.Now().Unix())
    return err
})

scheduler.Add("daily-report", "0 9 * * *", func(ctx context.Context) error {
    // runs at 9:00 AM UTC every day
    return generateReport(ctx)
})

scheduler.Add("every-five-minutes", "*/5 * * * *", func(ctx context.Context) error {
    return checkHealth(ctx)
})
```

The context is cancelled when the scheduler stops, allowing jobs to clean up gracefully.

---

## Cron expression syntax

Standard 5-field format: `minute hour day-of-month month day-of-week`

| Field | Range | Special |
|-------|-------|---------|
| Minute | 0-59 | `*`, `*/n`, `,`, `-` |
| Hour | 0-23 | `*`, `*/n`, `,`, `-` |
| Day of month | 1-31 | `*`, `*/n`, `,`, `-` |
| Month | 1-12 | `*`, `*/n`, `,`, `-` |
| Day of week | 0-6 (Sun=0) | `*`, `*/n`, `,`, `-` |

Examples:

| Expression | Meaning |
|------------|---------|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour at :00 |
| `30 * * * *` | Every hour at :30 |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 3 * * *` | Daily at 3:00 AM |
| `0 0 * * 1` | Every Monday at midnight |
| `0 9 1 * *` | First day of every month at 9:00 AM |

---

## Lifecycle integration

Wire the scheduler into the Stanza lifecycle:

```go
func provideCron(lc *lifecycle.Lifecycle, db *sqlite.DB, q *queue.Queue, logger *log.Logger) *cron.Scheduler {
    s := cron.NewScheduler(cron.WithLogger(logger))

    s.Add("purge-completed-jobs", "0 * * * *", func(ctx context.Context) error {
        _, err := q.Purge(24 * time.Hour)
        return err
    })

    s.Add("purge-expired-tokens", "30 * * * *", func(ctx context.Context) error {
        _, err := db.Exec("DELETE FROM refresh_tokens WHERE expires_at < ?", time.Now().Unix())
        return err
    })

    lc.Append(lifecycle.Hook{
        OnStart: s.Start,
        OnStop:  s.Stop,
    })

    return s
}
```

---

## Runtime management

### List jobs

```go
entries := scheduler.Entries()
for _, e := range entries {
    fmt.Printf("%-25s %-15s enabled=%-5v running=%-5v next=%s\n",
        e.Name, e.Schedule, e.Enabled, e.Running, e.NextRun)
}
```

Each `Entry` is a snapshot containing:

| Field | Type | Description |
|-------|------|-------------|
| `Name` | `string` | Job name |
| `Schedule` | `string` | Cron expression |
| `Enabled` | `bool` | Whether job will run on schedule |
| `Running` | `bool` | Whether job is currently executing |
| `LastRun` | `time.Time` | When the job last ran |
| `NextRun` | `time.Time` | When the job will next run |
| `LastErr` | `error` | Error from the last execution |

### Scheduler stats

```go
stats := scheduler.Stats()
fmt.Printf("completed=%d failed=%d skipped=%d\n",
    stats.Completed, stats.Failed, stats.Skipped)
```

`SchedulerStats` holds cumulative counters since the scheduler was created:

| Field | Type | Description |
|-------|------|-------------|
| `Jobs` | `int` | Total registered jobs |
| `Completed` | `int64` | Successful executions |
| `Failed` | `int64` | Executions that returned an error or panicked |
| `Skipped` | `int64` | Times a due job was skipped because it was still running |

Counters use `sync/atomic` internally — `Stats()` is safe to call from any goroutine.

### Enable and disable jobs

```go
scheduler.Disable("daily-report")  // skip scheduled runs
scheduler.Enable("daily-report")   // resume scheduled runs
```

Disabled jobs remain registered but are not executed on their schedule.

### Trigger a job manually

```go
scheduler.Trigger("cleanup-sessions")  // run now, regardless of schedule
```

The job runs in a new goroutine. Returns an error if the job is not found or is already running.
