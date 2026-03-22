---
title: Lifecycle & DI
nextjs:
  metadata:
    title: Lifecycle & DI
    description: Dependency injection container with automatic resolution and ordered startup/shutdown.
---

The `pkg/lifecycle` package provides a dependency injection container with automatic dependency resolution and ordered lifecycle hooks. It draws from Uber's `fx` but is rebuilt from scratch — zero external dependencies.

```go
import "github.com/stanza-go/framework/pkg/lifecycle"
```

---

## Why this exists

A Stanza app runs HTTP server, cron scheduler, and job queue workers in a single process. These subsystems have real ordering requirements: open the database before anything else, run migrations before handlers register, drain HTTP requests before stopping, close the database last. This is the one place where a DI and lifecycle package earns its weight.

---

## Creating an app

Use `lifecycle.New` with `Provide` and `Invoke` options to wire your application:

```go
app := lifecycle.New(
    lifecycle.Provide(
        provideConfig,
        provideLogger,
        provideDB,
        provideRouter,
        provideServer,
    ),
    lifecycle.Invoke(registerModules),
)

if err := app.Err(); err != nil {
    log.Fatal(err)
}

if err := app.Run(); err != nil {
    log.Fatal(err)
}
```

`Run` starts all lifecycle hooks in registration order, blocks until `SIGINT` or `SIGTERM`, then stops hooks in reverse order.

---

## Provide

`Provide` registers constructor functions. Each constructor declares its dependencies as parameters and returns the values it produces:

```go
func provideDB(cfg *config.Config, logger *log.Logger) *sqlite.DB {
    db := sqlite.New(cfg.GetString("data.dir") + "/database.sqlite")
    return db
}

func provideServer(router *http.Router) *http.Server {
    return http.NewServer(router, http.WithAddr(":23710"))
}
```

The container resolves dependencies automatically via topological sort. Order of `Provide` calls does not matter — the container figures out the correct initialization sequence from the function signatures.

Constructor results are cached as singletons. Each constructor runs exactly once.

---

## Invoke

`Invoke` registers functions that execute after all constructors have been resolved. Use it for side effects like registering routes:

```go
func registerModules(router *http.Router, db *sqlite.DB) {
    health.Register(router)
    dashboard.Register(router.Group("/api/admin"), db)
}
```

Invoke functions run in registration order. Their parameters are resolved from the container just like constructors, but their return values are not stored.

---

## Lifecycle hooks

Constructors can accept `*lifecycle.Lifecycle` to register startup and shutdown hooks:

```go
func provideDB(lc *lifecycle.Lifecycle, cfg *config.Config) *sqlite.DB {
    db := sqlite.New(cfg.GetString("db.path"))

    lc.Append(lifecycle.Hook{
        OnStart: func(ctx context.Context) error {
            if err := db.Start(ctx); err != nil {
                return err
            }
            _, err := db.Migrate()
            return err
        },
        OnStop: func(ctx context.Context) error {
            return db.Stop(ctx)
        },
    })

    return db
}
```

- `OnStart` hooks run in the order they were appended (first registered, first started)
- `OnStop` hooks run in reverse order (last registered, first stopped)

This ensures the database starts before the HTTP server and stops after it.

---

## Timeouts

Configure how long the app waits for hooks to complete:

```go
app := lifecycle.New(
    lifecycle.WithStartTimeout(30 * time.Second),  // default: 15s
    lifecycle.WithStopTimeout(30 * time.Second),    // default: 15s
    lifecycle.Provide(...),
)
```

If hooks don't complete within the timeout, the context is cancelled.

---

## Programmatic shutdown

Call `app.Shutdown()` from anywhere to trigger graceful shutdown:

```go
func provideServer(lc *lifecycle.Lifecycle, app *lifecycle.App) *http.Server {
    // ... if something goes wrong, trigger shutdown
    app.Shutdown()
}
```

`Shutdown` is safe to call multiple times and from multiple goroutines.

---

## API reference

### Types

| Type | Description |
|------|-------------|
| `App` | Manages dependency injection and application lifecycle |
| `Lifecycle` | Manages ordered startup and shutdown hooks |
| `Hook` | Pair of `OnStart` and `OnStop` callbacks |
| `Option` | Functional option for configuring `App` |

### Functions

| Function | Description |
|----------|-------------|
| `New(opts ...Option) *App` | Creates app, resolves dependencies, runs invoke functions |
| `Provide(constructors ...any) Option` | Registers constructor functions |
| `Invoke(funcs ...any) Option` | Registers functions that run after constructors |
| `WithStartTimeout(d time.Duration) Option` | Sets start timeout (default 15s) |
| `WithStopTimeout(d time.Duration) Option` | Sets stop timeout (default 15s) |

### App methods

| Method | Description |
|--------|-------------|
| `Err() error` | Returns initialization error, if any |
| `Start(ctx) error` | Runs all OnStart hooks in order |
| `Stop(ctx) error` | Runs all OnStop hooks in reverse order |
| `Run() error` | Start + block until signal + Stop |
| `Shutdown()` | Triggers graceful shutdown |

### Lifecycle methods

| Method | Description |
|--------|-------------|
| `Append(Hook)` | Adds a lifecycle hook |
