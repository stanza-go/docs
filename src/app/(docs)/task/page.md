---
title: Task pool
nextjs:
  metadata:
    title: Task pool
    description: Bounded in-memory worker pool for fire-and-forget background tasks with panic recovery and graceful shutdown.
---

The `pkg/task` package provides a bounded worker pool for fire-and-forget background tasks. It fills the gap between synchronous inline execution and the persistent, SQLite-backed [job queue](/queue): tasks run concurrently in memory with panic recovery and graceful shutdown, but are not persisted or retried.

```go
import "github.com/stanza-go/framework/pkg/task"
```

---

## When to use task vs queue

| | Task pool | Job queue |
|---|---|---|
| **Persistence** | In-memory only — lost on crash | SQLite-backed — survives restarts |
| **Retry** | No | Yes, with configurable backoff |
| **Use case** | Email sends, cache warming, webhook fanout | Payment processing, report generation, data imports |
| **Overhead** | Near zero (goroutine + channel) | DB write per job |

Use the task pool when losing the work on a crash is acceptable. Use the queue when the work must complete eventually.

---

## Creating a pool

```go
p := task.New(
    task.WithWorkers(4),
    task.WithBuffer(100),
    task.WithLogger(logger),
)
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `WithWorkers(n)` | `4` | Number of concurrent worker goroutines |
| `WithBuffer(n)` | `100` | Task buffer capacity; `Submit` returns `false` when full |
| `WithLogger(l)` | — | Logger for panic recovery messages |

---

## Lifecycle integration

The pool must be started before use and stopped on shutdown. Integrate with the lifecycle system:

```go
lc.Append(lifecycle.Hook{
    OnStart: p.Start,
    OnStop:  p.Stop,
})
```

`Stop` closes the task channel, drains any buffered tasks, and waits for all in-flight workers to finish before returning.

---

## Submitting tasks

`Submit` enqueues a function for background execution. It returns `true` if the task was accepted, `false` if the buffer is full or the pool is stopped.

```go
ok := p.Submit(func() {
    _, _ = emailClient.Send(context.Background(), msg)
})
```

### Fallback pattern

When the pool is full, fall back to synchronous execution so the work still gets done:

```go
send := func() {
    _, _ = emailClient.Send(context.Background(), msg)
}
if !p.Submit(send) {
    // Pool full — send synchronously as fallback.
    send()
}
```

This is the pattern used in the standalone app's notification service and password reset module.

### Context considerations

Tasks submitted to the pool should **not** use the original HTTP request context. The request may complete (and its context cancel) before the pool runs the task. Use `context.Background()` or a detached context:

```go
// Wrong — context may be cancelled before the task runs.
p.Submit(func() {
    emailClient.Send(r.Context(), msg)
})

// Correct — detached context survives the request.
p.Submit(func() {
    emailClient.Send(context.Background(), msg)
})
```

---

## Panic recovery

If a submitted task panics, the worker recovers the panic, logs it (if a logger is configured), increments the panic counter, and continues processing the next task. Workers are never killed by panics.

---

## Pool stats

`Stats` returns a snapshot of pool counters — useful for monitoring and Prometheus metrics:

```go
s := p.Stats()
fmt.Println(s.Submitted, s.Completed, s.Dropped, s.Panics)
```

| Field | Type | Description |
|-------|------|-------------|
| `Workers` | `int` | Configured worker count |
| `Buffer` | `int` | Configured buffer capacity |
| `Pending` | `int` | Tasks currently waiting in the buffer |
| `Submitted` | `int64` | Total tasks accepted by `Submit` |
| `Completed` | `int64` | Total tasks finished successfully |
| `Panics` | `int64` | Total tasks that panicked (recovered) |
| `Dropped` | `int64` | Total tasks rejected (buffer full or pool stopped) |

Counters are cumulative and use `sync/atomic` — calling `Stats` is lock-free.

---

## Prometheus metrics

The standalone app exports pool stats as Prometheus metrics at `GET /api/metrics`:

| Metric | Type | Description |
|--------|------|-------------|
| `stanza_task_pool_workers` | gauge | Worker goroutine count |
| `stanza_task_pool_pending` | gauge | Tasks waiting in buffer |
| `stanza_task_pool_submitted_total` | counter | Total tasks submitted |
| `stanza_task_pool_completed_total` | counter | Total tasks completed |
| `stanza_task_pool_dropped_total` | counter | Total tasks dropped |
| `stanza_task_pool_panics_total` | counter | Total panicked tasks |

---

## API reference

| Method | Signature | Description |
|--------|-----------|-------------|
| `New` | `New(opts ...Option) *Pool` | Create a new pool |
| `Start` | `(ctx context.Context) error` | Launch workers |
| `Stop` | `(ctx context.Context) error` | Drain and wait for all tasks |
| `Submit` | `(fn func()) bool` | Enqueue a task; `false` if full/stopped |
| `Stats` | `() Stats` | Pool statistics snapshot |

---

## Tips

- **Keep tasks short.** The pool has a fixed number of workers. A long-running task blocks a worker slot. For work that takes more than a few seconds, use the [job queue](/queue) instead.
- **Don't rely on ordering.** Tasks may execute in any order depending on which worker picks them up.
- **Size the buffer for bursts.** The default buffer of 100 handles most cases. If you see `Dropped` increasing, either increase the buffer or add more workers.
- **Nil functions are ignored.** `Submit(nil)` returns `true` without queuing anything.

See the [Sending emails](/recipes/sending-emails) recipe for the async email pattern used in the standalone app.
