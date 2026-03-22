---
title: Configuration management
nextjs:
  metadata:
    title: Configuration management
    description: Practical patterns for managing config in a Stanza app — adding keys, organizing defaults, handling secrets, and configuring for different environments.
---

This recipe covers the practical patterns for managing configuration in a Stanza app. The [Configuration reference](/docs/configuration) documents the `config` package API. This recipe shows how to apply it — adding config for new modules, organizing defaults, handling secrets, and running the same binary across development, staging, and production.

---

## The config layer

A Stanza app has three configuration sources, resolved in priority order:

```
Environment variables  >  config.yaml  >  Defaults (in code)
```

**Defaults** are defined in `provideConfig` inside `main.go`. They represent sane values for local development. **config.yaml** lives in the data directory and provides overrides without rebuilding. **Environment variables** override everything — this is how production config works on Railway, Cloud Run, or Docker.

The config object is created once at boot and injected into providers via the DI container. It is immutable after creation.

---

## Adding config for a new module

When you add a new module that needs configuration, the pattern has three steps.

### 1. Add defaults in provideConfig

```go
func provideConfig(dir *datadir.Dir) *config.Config {
    cfg, err := config.Load(dir.Config,
        config.WithEnvPrefix("STANZA"),
        config.WithDefaults(map[string]string{
            "server.addr": ":23710",
            "log.level":   "info",

            // Payments module
            "payments.provider":   "stripe",
            "payments.webhook_secret": "",
        }),
    )
    // ...
}
```

Every config key should have a default — even if the default is empty string. This documents the key's existence in one place and makes it visible to anyone reading `provideConfig`.

### 2. Read config in the provider

```go
func providePayments(cfg *config.Config, logger *log.Logger) *payments.Client {
    provider := cfg.GetString("payments.provider")
    apiKey := cfg.GetString("payments.api_key")
    webhookSecret := cfg.GetString("payments.webhook_secret")

    if apiKey == "" {
        logger.Warn("payments: no API key configured, payment operations will fail")
    }

    return payments.New(provider, apiKey, webhookSecret)
}
```

Config is consumed in provider functions, not in handlers. Providers receive `*config.Config` via DI and extract what they need. Handlers receive the already-configured service — they never touch the config object directly.

### 3. Set environment variables in production

```shell
STANZA_PAYMENTS_PROVIDER=stripe
STANZA_PAYMENTS_API_KEY=sk_live_...
STANZA_PAYMENTS_WEBHOOK_SECRET=whsec_...
```

The env var name is derived from the key: uppercase, dots become underscores, prefixed with `STANZA`. The key `payments.api_key` becomes `STANZA_PAYMENTS_API_KEY`.

---

## Key naming conventions

Use dot-separated namespaces. The first segment is the concern, the rest describes the specific setting:

```
server.addr
log.level
auth.signing_key
auth.secure_cookies
email.resend_api_key
email.from
cors.origins
payments.provider
payments.api_key
sms.twilio_sid
sms.twilio_token
```

Keep names lowercase with underscores. Avoid deeply nested keys — two levels is the maximum the YAML parser supports. One level of nesting (e.g., `server.addr`) covers all practical cases.

---

## Secrets vs settings

Not all config belongs in the same place. Split by sensitivity:

| Type | Where | Examples |
|------|-------|---------|
| **Secrets** | Environment variables only | Signing keys, API keys, tokens, database passwords |
| **Tuning** | Defaults in code, override via env or config.yaml | Server address, log level, timeouts, pool sizes |
| **Feature flags** | Defaults in code or config.yaml | Feature toggles, A/B test flags |

Secrets should never appear in config.yaml or source code. They belong exclusively in environment variables, set via your deployment platform's secret management (Railway variables, Cloud Run secrets, Docker secrets).

```go
// Good — secret read from env only (no default)
signingKey := cfg.GetString("auth.signing_key")

// Good — tuning param with a sensible default
addr := cfg.GetStringOr("server.addr", ":23710")
```

{% callout title="Signing key warning" type="warning" %}
If `auth.signing_key` is empty, the standalone app generates a random key. This works for development but means every restart invalidates all JWTs. Always set `STANZA_AUTH_SIGNING_KEY` in production.
{% /callout %}

---

## Organizing provideConfig

As your app grows, the defaults map gets longer. Keep it organized by concern with blank lines and comments:

```go
func provideConfig(dir *datadir.Dir) *config.Config {
    cfg, err := config.Load(dir.Config,
        config.WithEnvPrefix("STANZA"),
        config.WithDefaults(map[string]string{
            // Server
            "server.addr": ":23710",

            // Logging
            "log.level": "info",

            // CORS
            "cors.origins": "http://localhost:23706,http://localhost:23700",

            // Email
            "email.from": "noreply@myapp.com",

            // Payments
            "payments.provider": "stripe",
        }),
    )
    if err != nil {
        cfg = config.New(
            config.WithEnvPrefix("STANZA"),
            config.WithDefaults(map[string]string{
                "server.addr": ":23710",
                "log.level":   "info",
            }),
        )
    }
    return cfg
}
```

The `Load` call can fail if the config file exists but has a parse error. The fallback to `config.New` keeps the app running with just defaults and env vars — this is important for first boot when no config.yaml exists yet.

---

## Environment-specific patterns

The same binary runs in every environment. Only environment variables change.

### Development

No env vars needed — defaults cover everything:

```shell
# Just run it
make dev

# Override one setting for a specific test
STANZA_LOG_LEVEL=debug make dev
```

Set `STANZA_AUTH_SECURE_COOKIES=false` if testing auth over plain HTTP (the admin and UI Vite dev servers proxy to the API over HTTP).

### Staging

Mirrors production config with staging-specific values:

```shell
DATA_DIR=/data
STANZA_AUTH_SIGNING_KEY=staging-key-here
STANZA_AUTH_SECURE_COOKIES=true
STANZA_EMAIL_RESEND_API_KEY=re_staging_...
STANZA_EMAIL_FROM="MyApp Staging <staging@myapp.com>"
STANZA_LOG_LEVEL=debug
```

### Production

Minimal, locked down:

```shell
DATA_DIR=/data
STANZA_AUTH_SIGNING_KEY=<64-char-hex-secret>
STANZA_AUTH_SECURE_COOKIES=true
STANZA_EMAIL_RESEND_API_KEY=re_live_...
STANZA_EMAIL_FROM="MyApp <noreply@myapp.com>"
STANZA_LOG_LEVEL=warn
```

There is no "environment" config key. The binary doesn't know or care whether it's running in dev, staging, or production. It only sees the values it's given.

---

## Config vs runtime settings

Stanza has two distinct systems for application configuration:

| | Config (`pkg/config`) | Settings (in SQLite) |
|-|---|---|
| **When loaded** | Once at boot | Anytime at runtime |
| **Changed by** | Developer / ops (env vars, YAML) | Admin via admin panel |
| **Requires restart** | Yes (for code that reads config at boot) | No |
| **Examples** | Signing key, server address, log level, API keys | Site name, maintenance mode, email templates, feature flags |

Use `config` for infrastructure settings that the binary needs before it can start serving. Use the SQLite-backed settings table (managed through the Settings admin page) for anything an admin should be able to change without redeploying.

---

## The PORT override pattern

Cloud platforms (Railway, Cloud Run, Fly) set a `PORT` environment variable. The standalone app checks for it:

```go
func provideServer(lc *lifecycle.Lifecycle, router *http.Router, cfg *config.Config, logger *log.Logger) *http.Server {
    addr := cfg.GetStringOr("server.addr", ":23710")
    // Railway, Cloud Run, etc. set PORT — always prefer it when present.
    if port := os.Getenv("PORT"); port != "" {
        addr = ":" + port
    }
    // ...
}
```

`PORT` takes absolute priority over `STANZA_SERVER_ADDR` and `server.addr`. This ensures the app binds to the port the platform expects. Do not set `PORT` yourself — let the platform manage it.

---

## Optional services

Some modules only activate when their config is set. The email client demonstrates this:

```go
func provideEmail(cfg *config.Config, logger *log.Logger) *email.Client {
    apiKey := cfg.GetString("email.resend_api_key")
    from := cfg.GetStringOr("email.from", "noreply@stanza.dev")

    if apiKey == "" {
        logger.Info("email: no API key, email sending disabled")
    }

    return email.New(apiKey, email.WithFrom(from))
}
```

The email client is always created, but callers check `client.Configured()` before sending:

```go
if emailClient.Configured() {
    _, err := emailClient.Send(ctx, email.Message{
        To:      []string{user.Email},
        Subject: "Password reset",
        HTML:    resetEmailHTML(token),
    })
}
```

This pattern keeps the DI wiring simple — no conditional provides — while gracefully degrading when optional services aren't configured. Apply the same pattern for any external integration (SMS, payments, push notifications).

---

## CORS origins from config

The standalone reads CORS origins as a comma-separated string:

```go
originsStr := cfg.GetStringOr("cors.origins", "http://localhost:23706,http://localhost:23700")
if originsStr != "" {
    var origins []string
    for _, o := range strings.Split(originsStr, ",") {
        if s := strings.TrimSpace(o); s != "" {
            origins = append(origins, s)
        }
    }
    if len(origins) > 0 {
        router.Use(http.CORS(http.CORSConfig{
            AllowOrigins:     origins,
            AllowCredentials: true,
        }))
    }
}
```

In production, set the actual domain:

```shell
STANZA_CORS_ORIGINS=https://myapp.com,https://admin.myapp.com
```

Or disable CORS entirely by leaving it empty when the binary serves everything on one domain (the default production setup with embedded frontends).

---

## Required keys with validation

For keys that must be present in production, use `WithRequired` and call `Validate`:

```go
cfg, err := config.Load(dir.Config,
    config.WithEnvPrefix("STANZA"),
    config.WithDefaults(map[string]string{
        "server.addr": ":23710",
    }),
    config.WithRequired("auth.signing_key"),
)
if err != nil {
    return nil, err
}
if err := cfg.Validate(); err != nil {
    return nil, err // "config: missing required keys: auth.signing_key"
}
```

{% callout title="When to use validation" %}
Use `WithRequired` for keys that would cause silent misbehavior if missing — signing keys, database paths, external API keys the app depends on. Don't mark everything as required — an empty `log.level` just means the default applies.
{% /callout %}

---

## Rules

1. **All config keys in one place.** Every key appears in the `provideConfig` defaults map — even if the default is empty. This is the single source of truth for what the app can be configured with.
2. **Providers consume config, handlers don't.** Config flows through provider functions at boot. Handlers receive configured services — they never import or read the config package.
3. **Secrets in env vars only.** API keys, signing keys, and tokens never go in config.yaml or source code.
4. **No environment detection.** The binary doesn't know it's in "dev" or "prod". It reads the values it's given. Different environments are just different env var sets.
5. **Optional services degrade gracefully.** Create the service unconditionally in the provider. Check `Configured()` or a similar guard at call sites. Don't litter providers with conditionals.
6. **Config is boot-time, settings are runtime.** If an admin should change it without redeploying, it belongs in the settings table, not in config.
