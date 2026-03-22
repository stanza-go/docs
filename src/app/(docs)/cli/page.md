---
title: CLI commands
nextjs:
  metadata:
    title: CLI commands
    description: The pkg/cmd package for building CLI tools, plus all stanza CLI commands.
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

### stanza logs

View and tail structured JSON log files:

```shell
# Show last 50 lines (default)
stanza logs

# Show last 100 lines
stanza logs --lines 100

# Follow new entries in real-time (like tail -f)
stanza logs --follow

# Filter by minimum level
stanza logs --level error

# Output raw JSON instead of formatted
stanza logs --json

# Read a specific rotated log file
stanza logs --file stanza-2026-03-21.log

# List available log files with sizes
stanza logs --list

# Disable colored output
stanza logs --no-color
```

In formatted mode (the default), JSON log entries are displayed as human-readable lines with colored log levels, timestamps reformatted to local time, and extra fields shown as `key=value` pairs. Raw JSON mode (`--json`) prints each line as-is.

The `--level` filter accepts `debug`, `info`, `warn`, or `error`. Only lines at or above the specified level are shown. Filtered lines do not count toward the `--lines` limit.

The `--follow` flag watches the log file for new content, checking every 300ms. Combine with `--level` to follow only errors in real-time:

```shell
stanza logs --follow --level error
```

| Flag | Default | Description |
|------|---------|-------------|
| `--lines` | `50` | Number of lines to show |
| `--follow` | `false` | Follow new log entries |
| `--level` | — | Minimum log level (debug, info, warn, error) |
| `--file` | `stanza.log` | Log file to read |
| `--json` | `false` | Output raw JSON |
| `--no-color` | `false` | Disable colored output |
| `--list` | `false` | List available log files |
| `--data-dir` | — | Override data directory |

### stanza status

Show a health summary of the data directory:

```shell
stanza status

# With custom data directory
stanza status --data-dir /data

# Disable colors (for scripts)
stanza status --no-color
```

Inspects the data directory and reports on each component:

- **Database** — file size, WAL size, SHM presence, last modified time
- **Logs** — number of log files, total size, most recent file
- **Uploads** — file count and total size (recursive)
- **Backups** — file count, total size, most recent backup
- **Config** — whether `config.yaml` exists, its size and modification time

If the data directory does not exist, the command reports `NOT FOUND` without error.

| Flag | Default | Description |
|------|---------|-------------|
| `--no-color` | `false` | Disable colored output |
| `--data-dir` | — | Override data directory |

### stanza db

Show database statistics, table information, and migration history:

```shell
stanza db

# With custom data directory
stanza db --data-dir /data
```

Opens the database in read-only mode and displays:

- **Database info** — file path, size, WAL size
- **Engine** — SQLite version, journal mode, page size, page count, free pages
- **Tables** — all tables with row counts
- **Migrations** — total applied, last 5 migrations with version, name, and application date

The database is opened with `PRAGMA query_only = true` so the command never modifies data.

| Flag | Default | Description |
|------|---------|-------------|
| `--no-color` | `false` | Disable colored output |
| `--data-dir` | — | Override data directory |

### stanza backup

Create a consistent database backup using SQLite's `VACUUM INTO`:

```shell
stanza backup

# Custom output path
stanza backup --output /backups/daily.sqlite

# Gzip-compressed backup
stanza backup --compress

# Both
stanza backup --output /backups/daily.sqlite.gz --compress
```

Unlike `stanza export` (which zips the entire data directory), `stanza backup` creates a compacted, self-contained copy of just the database file. `VACUUM INTO` guarantees all WAL data is included — the backup is always consistent, even while the application is running.

With `--compress`, the backup is gzip-compressed after compaction. SQLite databases compress extremely well (often 10x reduction).

| Flag | Default | Description |
|------|---------|-------------|
| `--output` | `stanza-backup-{timestamp}.sqlite` | Output file path |
| `--compress` | `false` | Gzip-compress the backup |
| `--data-dir` | — | Override data directory |

---

### Data directory resolution

All commands resolve the data directory in this order:

1. `--data-dir` flag (highest priority)
2. `DATA_DIR` environment variable
3. `~/.stanza/` (default)
