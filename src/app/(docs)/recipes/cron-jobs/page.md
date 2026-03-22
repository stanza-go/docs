---
title: Custom cron jobs
nextjs:
  metadata:
    title: Custom cron jobs
    description: How to add scheduled tasks that run in-process on a cron schedule.
---

Stanza's cron scheduler runs in-process — no external scheduler, no separate worker. This recipe shows how to add custom cron jobs to your application.

---

## Where cron jobs live

All cron jobs are registered in the `provideCron` function in `api/main.go`. This function receives dependencies from the DI container and returns a configured scheduler:

```go
func provideCron(lc *lifecycle.Lifecycle, db *sqlite.DB, q *queue.Queue, logger *log.Logger) (*cron.Scheduler, error) {
    s := cron.NewScheduler(
        cron.WithLogger(logger),
        cron.WithDefaultTimeout(10 * time.Minute), // prevent hung jobs
        cron.WithOnComplete(func(r cron.CompletedRun) {
            // persist run history to cron_runs table
        }),
    )

    // register jobs here

    lc.Append(lifecycle.Hook{
        OnStart: s.Start,
        OnStop:  s.Stop,
    })

    return s, nil
}
```

---

## Adding a simple cron job

Add a new `s.Add()` call inside `provideCron`, before the lifecycle hook:

```go
if err := s.Add("cleanup-old-products", "0 2 * * *", func(ctx context.Context) error {
    sql, args := sqlite.Delete("products").
        Where("deleted_at IS NOT NULL").
        Where("deleted_at < ?", time.Now().Add(-30*24*time.Hour).UTC().Format(time.RFC3339)).
        Build()
    result, err := db.Exec(sql, args...)
    if err != nil {
        return err
    }
    if result.RowsAffected > 0 {
        logger.Info("purged old products", log.Int64("count", result.RowsAffected))
    }
    return nil
}); err != nil {
    return nil, fmt.Errorf("cron add cleanup-old-products: %w", err)
}
```

This runs daily at 2:00 AM UTC, removing products that were soft-deleted more than 30 days ago.

---

## Cron expression quick reference

Format: `minute hour day-of-month month day-of-week`

| Expression | Schedule |
|------------|----------|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour at :00 |
| `30 * * * *` | Every hour at :30 |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 2 * * *` | Daily at 2:00 AM |
| `0 0 * * 1` | Every Monday at midnight |
| `0 9 1 * *` | First of each month at 9:00 AM |

---

## Combining cron with the job queue

For long-running work, the cron job should enqueue a queue job rather than doing the work directly. This keeps the cron tick fast and lets the queue handle retries:

```go
if err := s.Add("generate-daily-report", "0 8 * * *", func(ctx context.Context) error {
    payload, _ := json.Marshal(map[string]string{
        "date": time.Now().UTC().Format("2006-01-02"),
    })
    _, err := q.Enqueue(ctx, "generate-report", payload)
    return err
}); err != nil {
    return nil, fmt.Errorf("cron add generate-daily-report: %w", err)
}
```

The cron job fires at 8:00 AM and enqueues the work. A separate queue handler (see [Queue jobs](/docs/recipes/queue-jobs)) processes it with retries.

---

## Run history

If `WithOnComplete` is configured on the scheduler, every job execution is recorded in the `cron_runs` table. The admin panel shows this history automatically — last run time, duration, success/failure status, and error messages.

---

## Runtime management

Cron jobs can be managed through the admin API without restarting:

```
GET  /api/admin/cron              — list all jobs with status
POST /api/admin/cron/{name}/trigger — run a job immediately
POST /api/admin/cron/{name}/enable  — resume scheduled runs
POST /api/admin/cron/{name}/disable — pause scheduled runs
GET  /api/admin/cron/{name}/runs    — view execution history
```

---

## Built-in cron jobs

The standalone app ships with maintenance cron jobs. All use the 10-minute default timeout except `daily-backup` (30 minutes):

| Name | Schedule | Timeout | Purpose |
|------|----------|---------|---------|
| `purge-completed-jobs` | `0 * * * *` | 10m | Remove completed queue jobs older than 24h |
| `purge-expired-tokens` | `30 * * * *` | 10m | Delete expired refresh tokens |
| `purge-stale-api-keys` | `0 3 * * *` | 10m | Remove revoked API keys older than 30 days |
| `purge-old-cron-runs` | `30 3 * * *` | 10m | Delete run history older than 7 days |
| `purge-old-audit-log` | `0 4 * * *` | 10m | Archive audit entries older than 90 days |
| `purge-old-reset-tokens` | `30 4 * * *` | 10m | Delete used/expired password reset tokens |
| `purge-old-notifications` | `0 5 * * *` | 10m | Remove read notifications older than 30 days |
| `daily-backup` | `0 2 * * *` | 30m | VACUUM INTO backup of database |
| `purge-old-backups` | `30 2 * * *` | 10m | Remove backups older than 7 days |

These keep the SQLite database lean. Add your own jobs following the same pattern.

---

## Job timeouts

The standalone app uses `WithDefaultTimeout(10 * time.Minute)` as a safety net. Override per-job when needed:

```go
// Backup can be slow on large databases
s.Add("daily-backup", "0 2 * * *", backupFn, cron.Timeout(30*time.Minute))

// Disable timeout for a specific job
s.Add("long-running-sync", "0 0 * * *", syncFn, cron.Timeout(0))
```

When a job exceeds its timeout, the context is cancelled and the job fails with a `"job timed out after Xs"` error. The error appears in run history and the admin panel.

---

## Tips

- Jobs must be added **before** `s.Start()` is called.
- Each job name must be unique — duplicates are rejected.
- The `ctx` passed to your job function is cancelled when the scheduler stops or when a timeout is reached, so respect context cancellation for graceful shutdown.
- A job that's already running won't be triggered again by the scheduler until it finishes.
- Log important outcomes — cron jobs run silently. Use `logger.Info()` or `logger.Error()` to make them observable.
- Always set a default timeout (`WithDefaultTimeout`) to prevent hung jobs from blocking shutdown.
