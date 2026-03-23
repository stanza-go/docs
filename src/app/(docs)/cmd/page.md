---
title: CLI toolkit
nextjs:
  metadata:
    title: CLI toolkit
    description: Command-line argument parser with subcommands, typed flags, and auto-generated help.
---

The `pkg/cmd` package provides a command-line argument parser with subcommand dispatch, typed flags, positional arguments, and automatic help generation. It is built entirely on Go's standard library — no external dependencies.

```go
import "github.com/stanza-go/framework/pkg/cmd"
```

---

## Creating an app

Create a top-level `App` with `New` and configure it with functional options:

```go
app := cmd.New("myapp",
    cmd.WithVersion("1.0.0"),
    cmd.WithDescription("My application server"),
)
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `WithVersion(v)` | `""` | Version string shown by `--version` |
| `WithDescription(d)` | `""` | Description shown in help output |
| `WithOutput(w)` | `os.Stderr` | Writer for help and version output |
| `WithDefaultCommand(name)` | `""` | Command to run when no subcommand is given |

---

## Registering commands

Register commands with a name, description, handler function, and optional flags:

```go
app.Command("serve", "Start the HTTP server", func(c *cmd.Context) error {
    addr := c.String("addr")
    fmt.Printf("Listening on %s\n", addr)
    return nil
}, cmd.StringFlag("addr", ":8080", "Listen address"))

app.Command("migrate", "Run database migrations", func(c *cmd.Context) error {
    verbose := c.Bool("verbose")
    // run migrations...
    return nil
}, cmd.BoolFlag("verbose", false, "Show migration details"))
```

Running `myapp serve --addr :3000` calls the serve handler with `addr` set to `:3000`.

The handler returns an `error` which the caller should handle — typically by printing the message and exiting with a non-zero status code.

---

## Subcommands

Commands can have subcommands for grouping related operations. Pass `nil` as the handler to create a grouping container:

```go
db := app.Command("db", "Database operations", nil)

db.Command("migrate", "Run pending migrations", func(c *cmd.Context) error {
    // ...
    return nil
})

db.Command("seed", "Seed initial data", func(c *cmd.Context) error {
    // ...
    return nil
})
```

Usage: `myapp db migrate`, `myapp db seed`. Running `myapp db` alone prints the subcommand help.

Subcommands can be nested to any depth, though one level is typical.

---

## Flag types

Four flag types are available, each as a `CommandOption` passed when registering a command:

| Function | Go type | Example |
|----------|---------|---------|
| `StringFlag(name, default, desc)` | `string` | `StringFlag("host", "0.0.0.0", "Bind address")` |
| `IntFlag(name, default, desc)` | `int` | `IntFlag("port", 8080, "Port to listen on")` |
| `BoolFlag(name, default, desc)` | `bool` | `BoolFlag("verbose", false, "Enable verbose output")` |
| `DurationFlag(name, default, desc)` | `time.Duration` | `DurationFlag("timeout", 30*time.Second, "Request timeout")` |

### Flag syntax

Flags use the `--name value` or `--name=value` syntax. Boolean flags are set to `true` by presence alone (`--verbose`) or explicitly (`--verbose=false`).

The `--` separator terminates flag parsing — everything after it is treated as positional arguments.

Unknown flags produce an error.

---

## Context

The `Context` is passed to the command handler and provides access to parsed flags and positional arguments:

```go
app.Command("greet", "Greet someone", func(c *cmd.Context) error {
    name := c.String("name")          // string flag
    count := c.Int("count")           // int flag
    loud := c.Bool("loud")            // bool flag
    timeout := c.Duration("timeout")  // duration flag

    if c.Has("name") {
        // flag was explicitly set on command line
    }

    args := c.Args()    // all positional arguments
    first := c.Arg(0)   // first positional arg, or "" if absent

    return nil
},
    cmd.StringFlag("name", "world", "Who to greet"),
    cmd.IntFlag("count", 1, "How many times"),
    cmd.BoolFlag("loud", false, "Shout the greeting"),
    cmd.DurationFlag("timeout", 5*time.Second, "Greeting timeout"),
)
```

### Context methods

| Method | Returns | Description |
|--------|---------|-------------|
| `String(name)` | `string` | String flag value, or `""` if not found |
| `Int(name)` | `int` | Integer flag value, or `0` if not found |
| `Bool(name)` | `bool` | Boolean flag value |
| `Duration(name)` | `time.Duration` | Duration flag value, or `0` if not found |
| `Has(name)` | `bool` | Whether the flag was explicitly set on the command line |
| `Args()` | `[]string` | All positional arguments after flag parsing |
| `Arg(i)` | `string` | Positional argument at index `i`, or `""` if out of range |

`Has` distinguishes between a flag set to its default and a flag not set at all. For example, `--port 8080` where the default is also `8080` — `Has("port")` returns `true` because the user explicitly provided it.

---

## Default command

Use `WithDefaultCommand` to dispatch a command automatically when no subcommand is given. This is how application binaries start a server by default:

```go
app := cmd.New("myapp",
    cmd.WithVersion("1.0.0"),
    cmd.WithDefaultCommand("serve"),
)

app.Command("serve", "Start the server", func(c *cmd.Context) error {
    return startServer()
})

app.Command("version", "Print build information", func(c *cmd.Context) error {
    fmt.Println("myapp v1.0.0")
    return nil
})
```

Without `WithDefaultCommand`, running `./myapp` with no arguments prints help. With it, `./myapp` and `./myapp serve` behave identically.

---

## Running the app

Pass `os.Args` to `Run`. It strips the program name, parses the subcommand and flags, and dispatches to the matching handler:

```go
if err := app.Run(os.Args); err != nil {
    fmt.Fprintf(os.Stderr, "error: %v\n", err)
    os.Exit(1)
}
```

Built-in flags handled before command dispatch:

| Flag | Effect |
|------|--------|
| `--version`, `-v` | Print version and exit |
| `--help`, `-h` | Print help and exit |

Per-command `--help` is also handled automatically — `myapp serve --help` prints the serve command's usage.

---

## Auto-generated help

Help is generated automatically from command names, descriptions, and flag definitions:

```
$ myapp --help
myapp v1.0.0

My application server

Usage:
  myapp <command> [flags]

Commands:
  serve     Start the HTTP server
  version   Print build information

Use "myapp <command> --help" for more information.

$ myapp serve --help
Start the HTTP server

Usage:
  myapp serve [flags]

Flags:
  --addr string  Listen address (default: :8080)
```

Flag defaults are shown automatically. Boolean flag defaults of `false` are omitted for cleanliness.

---

## Real-world examples

### Application binary with default command

The standalone app uses `WithDefaultCommand` so the binary starts the server by default, with `version` and `check` as secondary commands:

```go
cli := cmd.New("standalone",
    cmd.WithVersion(version),
    cmd.WithDescription("Stanza standalone application server"),
    cmd.WithDefaultCommand("serve"),
)

cli.Command("serve", "Start the application server", serveCmd)
cli.Command("version", "Print version and build information", versionCmd)
cli.Command("check", "Validate configuration and database connectivity", checkCmd)

if err := cli.Run(os.Args); err != nil {
    fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
    os.Exit(1)
}
```

### CLI tool with many flags

The `stanza` CLI tool registers commands with multiple flag types:

```go
app := cmd.New("stanza",
    cmd.WithVersion(version),
    cmd.WithDescription("Stanza CLI — project management for Stanza applications"),
)

app.Command("logs", "View and tail structured log files", runLogs,
    cmd.IntFlag("lines", 50, "Number of lines to show"),
    cmd.BoolFlag("follow", false, "Follow new log entries (like tail -f)"),
    cmd.StringFlag("level", "", "Minimum log level filter (debug, info, warn, error)"),
    cmd.StringFlag("file", "", "Log file to read (default: stanza.log)"),
    cmd.BoolFlag("json", false, "Output raw JSON instead of pretty-printed"),
    cmd.BoolFlag("no-color", false, "Disable colored output"),
    cmd.BoolFlag("list", false, "List available log files"),
    cmd.StringFlag("data-dir", "", "Data directory path"),
)

app.Command("backup", "Create a consistent database backup", runBackup,
    cmd.StringFlag("output", "", "Output file path"),
    cmd.StringFlag("data-dir", "", "Data directory path"),
    cmd.BoolFlag("compress", false, "Compress the backup with gzip"),
)
```

---

## Tips

- **Return errors, don't os.Exit.** Return errors from handlers and let the caller decide how to exit. This keeps handlers testable and composable.
- **Use `Has` for optional overrides.** When a flag has a meaningful default but you need to know if the user explicitly set it — for example, auto-generating an output filename only when `--output` is not provided.
- **Group related commands with subcommands.** `myapp db migrate` reads better than `myapp db-migrate`. Pass `nil` as the handler for the parent command.
- **Keep flag names consistent.** Reuse the same flag names across commands for shared concerns (`--data-dir`, `--no-color`, `--output`).

See [CLI commands](/cli) for the complete `stanza` CLI tool reference.
