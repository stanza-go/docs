---
title: CLI commands
nextjs:
  metadata:
    title: CLI commands
    description: The pkg/cmd package for building CLI tools, plus the stanza export/import commands.
---

The `pkg/cmd` package provides a command-line argument parser with subcommands, flags, and auto-generated help. The `stanza` CLI tool uses it for project management operations.

```go
import "github.com/stanza-go/framework/pkg/cmd"
```

---

## Building a CLI app

```go
app := cmd.New("myapp",
    cmd.WithVersion("1.0.0"),
    cmd.WithDescription("My application CLI"),
)

app.Command("serve", "Start the server", func(c *cmd.Context) error {
    addr := c.String("addr")
    fmt.Printf("Listening on %s\n", addr)
    return nil
}, cmd.StringFlag("addr", ":8080", "Listen address"))

app.Command("migrate", "Run database migrations", func(c *cmd.Context) error {
    verbose := c.Bool("verbose")
    // ...
    return nil
}, cmd.BoolFlag("verbose", false, "Show migration details"))

app.Run(os.Args)
```

Running `myapp serve --addr :3000` calls the serve handler with `addr` set to `:3000`.

---

## Subcommands

Commands can have subcommands. Pass `nil` as the run function for grouping containers:

```go
db := app.Command("db", "Database operations", nil)

db.Command("migrate", "Run migrations", func(c *cmd.Context) error {
    // ...
    return nil
})

db.Command("seed", "Seed initial data", func(c *cmd.Context) error {
    // ...
    return nil
})
```

Usage: `myapp db migrate`, `myapp db seed`.

---

## Flag types

Four flag types are available, each as a `CommandOption`:

```go
cmd.StringFlag("name", "default", "Description")
cmd.IntFlag("count", 10, "Description")
cmd.BoolFlag("verbose", false, "Description")
cmd.DurationFlag("timeout", 30*time.Second, "Description")
```

Flags are passed as `--name=value` or `--name value`. Bool flags can be set by presence alone (`--verbose`).

---

## Context

The `Context` provides access to parsed flags and positional arguments:

```go
app.Command("greet", "Greet someone", func(c *cmd.Context) error {
    name := c.String("name")       // flag value
    loud := c.Bool("loud")         // flag value
    timeout := c.Duration("timeout")

    if c.Has("name") {
        // flag was explicitly set on command line
    }

    args := c.Args()     // positional arguments after flags
    first := c.Arg(0)    // first positional arg, or ""

    return nil
},
    cmd.StringFlag("name", "world", "Who to greet"),
    cmd.BoolFlag("loud", false, "Shout the greeting"),
    cmd.DurationFlag("timeout", 5*time.Second, "Greeting timeout"),
)
```

---

## Auto-generated help

Help is generated automatically from command names, descriptions, and flag definitions:

```shell
$ myapp --help
My application CLI

Usage:
  myapp <command> [flags]

Commands:
  serve     Start the server
  migrate   Run database migrations

$ myapp serve --help
Start the server

Usage:
  myapp serve [flags]

Flags:
  --addr string    Listen address (default ":8080")
```

---

## The stanza CLI tool

The `cli/` repository provides the `stanza` binary for project management. It's built with `pkg/cmd`.

### stanza export

Exports the data directory as a zip archive:

```shell
# Export to auto-named file (stanza-export-<timestamp>.zip)
stanza export

# Export to specific path
stanza export --output backup.zip

# Export from custom data directory
stanza export --data-dir /path/to/data
```

The export is a byte-for-byte zip of the data directory. It includes the SQLite database, logs, uploads, and config.

### stanza import

Restores a data directory from a previously exported zip:

```shell
# Import with confirmation prompt
stanza import backup.zip

# Import without confirmation
stanza import --force backup.zip

# Import to custom data directory
stanza import --data-dir /path/to/data backup.zip
```

Import validates that the archive contains `database.sqlite` and includes zip slip protection against path traversal attacks.

### Data directory resolution

Both commands resolve the data directory in this order:

1. `--data-dir` flag (highest priority)
2. `DATA_DIR` environment variable
3. `~/.stanza/` (default)
