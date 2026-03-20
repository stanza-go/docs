---
title: Configuration
nextjs:
  metadata:
    title: Configuration
    description: Layered configuration with YAML files, environment variables, and type-safe getters.
---

The `pkg/config` package provides layered configuration loading: defaults, YAML file, and environment variables — in ascending priority order.

```go
import "github.com/stanza-go/framework/pkg/config"
```

---

## Loading configuration

### From file and environment

```go
cfg, err := config.Load("~/.stanza/config.yaml",
    config.WithDefaults(map[string]string{
        "server.addr": ":23710",
        "log.level":   "info",
    }),
    config.WithEnvPrefix("STANZA"),
    config.WithRequired("auth.signing_key"),
)
if err != nil {
    return err
}

if err := cfg.Validate(); err != nil {
    return err // lists all missing required keys
}
```

### Without a file

```go
cfg := config.New(
    config.WithDefaults(map[string]string{
        "server.addr": ":8080",
    }),
    config.WithEnvPrefix("MYAPP"),
)
```

---

## Resolution order

Values are resolved in this priority (highest wins):

1. **Environment variables** — `STANZA_SERVER_ADDR` overrides `server.addr`
2. **YAML file values** — from the config file
3. **Defaults** — set via `WithDefaults`

The environment variable name is derived from the key: uppercase, dots replaced with underscores, prefixed. For key `server.addr` with prefix `STANZA`, the env var is `STANZA_SERVER_ADDR`.

---

## Reading values

### Strings

```go
addr := cfg.GetString("server.addr")           // "" if not found
addr := cfg.GetStringOr("server.addr", ":8080") // fallback if empty
```

### Numbers

```go
port := cfg.GetInt("server.port")        // 0 if missing or invalid
size := cfg.GetInt64("max.upload.size")   // 0 if missing or invalid
rate := cfg.GetFloat64("throttle.rate")   // 0.0 if missing or invalid
```

### Booleans

```go
debug := cfg.GetBool("debug")
// Truthy: "true", "1", "yes", "on" (case-insensitive)
// Everything else: false
```

### Durations

```go
timeout := cfg.GetDuration("server.timeout")
// Parses Go duration strings: "30s", "5m", "1h30m"
// Returns 0 if missing or invalid
```

### Check existence

```go
if cfg.Has("smtp.host") {
    // key has a non-empty value from any source
}
```

---

## Validation

Mark keys as required, then call `Validate`:

```go
cfg, err := config.Load(path,
    config.WithRequired("auth.signing_key", "db.path"),
)

if err := cfg.Validate(); err != nil {
    // error message lists all missing required keys
    log.Fatal(err)
}
```

`Validate` checks that all required keys have non-empty values after resolving defaults, file, and environment.

---

## YAML file format

The config file uses flat dot-notation keys in YAML:

```yaml
server:
  addr: ":23710"

log:
  level: "debug"

auth:
  signing_key: "your-64-char-hex-key-here"
  secure_cookies: false

cors:
  origins: "http://localhost:23705,http://localhost:23700"
```

If the YAML file does not exist, it is silently skipped — the app works with defaults and environment variables only. This is intentional: the file is optional, the environment is always available.

---

## In a Stanza app

The standalone app loads config from the data directory:

```go
func provideConfig(dir *datadir.Dir) *config.Config {
    cfg, _ := config.Load(dir.Path("config.yaml"),
        config.WithDefaults(map[string]string{
            "server.addr":  ":23710",
            "log.level":    "info",
            "cors.origins": "http://localhost:23705,http://localhost:23700",
        }),
        config.WithEnvPrefix("STANZA"),
    )
    return cfg
}
```

Override any setting with environment variables in production:

```shell
STANZA_SERVER_ADDR=:8080
STANZA_LOG_LEVEL=warn
STANZA_AUTH_SIGNING_KEY=<64-char-hex>
DATA_DIR=/data
```
