---
title: Customizing your fork
nextjs:
  metadata:
    title: Customizing your fork
    description: What to change when you fork standalone — module path, data directory, auth routes, and local development setup.
---

After forking `stanza-go/standalone`, there are a few things to change before you start building. This page covers each one.

---

## Change the Go module path

The standalone repo uses `github.com/stanza-go/standalone` as its module path. Update it to match your fork:

```shell
cd api

# Update go.mod
sed -i '' 's|github.com/stanza-go/standalone|github.com/your-org/your-app|g' go.mod

# Update all imports across the codebase
find . -name '*.go' -exec sed -i '' 's|github.com/stanza-go/standalone|github.com/your-org/your-app|g' {} +
```

After renaming, verify it compiles:

```shell
go vet ./...
```

---

## Change the data directory

By default, all application state lives in `~/.stanza/`. The data directory name is defined in `api/datadir/datadir.go`:

```go
const defaultName = ".stanza"
```

Change it to match your project:

```go
const defaultName = ".my-app"
```

In production, override with the `DATA_DIR` environment variable — point it to your persistent volume:

```shell
DATA_DIR=/data ./my-app
```

The directory structure is created automatically on first boot:

```
~/.my-app/
├── database.sqlite      ← all data
├── logs/                ← structured logs
├── uploads/             ← user uploads
├── backups/             ← automatic backups
└── config.yaml          ← runtime config overrides
```

{% callout title="Multiple apps on one machine" %}
Each forked app needs its own data directory. If you're running multiple experiments locally, either change `defaultName` for each or use `DATA_DIR` to point them to separate directories. Without this, they'll share the same database.
{% /callout %}

---

## Change the app name and metadata

Update the app name in `api/main.go` — look for the health check and version info:

```go
// In provideServer or wherever the health response is built:
"app": "my-app",
```

Also update the `Makefile` and `Dockerfile` if you've renamed the binary.

---

## Environment variables

These environment variables control runtime behavior. Set them in your shell, `.env` file, or container platform:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATA_DIR` | `~/.stanza` | Where database, logs, uploads, and backups live |
| `PORT` | — | If set, server binds to `0.0.0.0:{PORT}` (Railway, Cloud Run) |
| `STANZA_SERVER_ADDR` | `:23710` | Server listen address (ignored when `PORT` is set) |
| `STANZA_AUTH_SIGNING_KEY` | random | Hex-encoded signing key (min 64 chars). Random = sessions don't survive restart |
| `STANZA_AUTH_SECURE_COOKIES` | `true` | Set to `false` for local HTTP development |
| `STANZA_CORS_ORIGINS` | `http://localhost:23706,http://localhost:23700` | Comma-separated allowed origins |
| `STANZA_EMAIL_RESEND_API_KEY` | — | Resend API key for transactional email |
| `STANZA_EMAIL_FROM` | — | From address for emails (e.g., `App <noreply@example.com>`) |

For local development, the minimum is:

```shell
export STANZA_AUTH_SECURE_COOKIES=false
```

For production, set at minimum `DATA_DIR` and `STANZA_AUTH_SIGNING_KEY`.

---

## Pre-built API routes

The standalone app ships with 33 modules. Here are all the endpoints, grouped by area.

### Admin authentication

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/admin/auth/login` | Authenticate admin (email + password) |
| `GET` | `/api/admin/auth` | Status check + access token refresh |
| `POST` | `/api/admin/auth/logout` | Revoke session, clear cookies |

### User authentication

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/auth/register` | Create new user account |
| `POST` | `/api/auth/login` | Authenticate user (email + password) |
| `GET` | `/api/auth` | Status check + access token refresh |
| `POST` | `/api/auth/logout` | Revoke session, clear cookies |

### Password reset

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/auth/forgot-password` | Request reset email |
| `POST` | `/api/auth/reset-password` | Reset with token |

### Admin panel endpoints

All admin endpoints require an authenticated admin session.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/admin/dashboard/stats` | System stats (uptime, memory, DB size, counts) |
| `GET` | `/api/admin/dashboard/charts` | Time-series data for dashboard charts |
| `GET/POST` | `/api/admin/admins` | List / create admin users |
| `GET/PUT/DELETE` | `/api/admin/admins/{id}` | Get / update / soft-delete admin |
| `GET/POST` | `/api/admin/roles` | List / create roles |
| `GET/PUT/DELETE` | `/api/admin/roles/{id}` | Get / update / delete role |
| `GET` | `/api/admin/scopes` | List all available scopes |
| `GET` | `/api/admin/sessions` | List active sessions |
| `DELETE` | `/api/admin/sessions/{id}` | Revoke a session |
| `GET/POST` | `/api/admin/users` | List / create end-users |
| `GET/PUT/DELETE` | `/api/admin/users/{id}` | Get / update / soft-delete end-user |
| `GET` | `/api/admin/audit` | Audit log (paginated, filterable) |
| `GET` | `/api/admin/cron` | List cron jobs with status |
| `POST` | `/api/admin/cron/{name}/run` | Trigger a cron job manually |
| `GET` | `/api/admin/queue/stats` | Queue counts by status |
| `GET` | `/api/admin/queue/jobs` | List jobs (filterable by status/type) |
| `GET` | `/api/admin/queue/jobs/{id}` | Job detail (payload, attempts, errors) |
| `POST` | `/api/admin/queue/jobs/{id}/retry` | Retry a failed/dead job |
| `POST` | `/api/admin/queue/jobs/{id}/cancel` | Cancel a pending job |
| `GET` | `/api/admin/logs` | Query structured logs |
| `GET` | `/api/admin/logs/stream` | SSE stream of live logs |
| `GET` | `/api/admin/db/stats` | Database stats (size, WAL, page count) |
| `POST` | `/api/admin/db/backup` | Create a backup |
| `GET` | `/api/admin/db/backups` | List backups |
| `GET` | `/api/admin/db/backups/{name}` | Download a backup |
| `DELETE` | `/api/admin/db/backups/{name}` | Delete a backup |
| `POST` | `/api/admin/db/integrity` | Run integrity check |
| `POST` | `/api/admin/db/optimize` | Run PRAGMA optimize |
| `GET/PUT` | `/api/admin/settings` | Get / update app settings |
| `GET/POST` | `/api/admin/webhooks` | List / create webhooks |
| `GET/PUT/DELETE` | `/api/admin/webhooks/{id}` | Get / update / delete webhook |
| `GET` | `/api/admin/webhooks/{id}/deliveries` | Webhook delivery log |
| `POST` | `/api/admin/webhooks/{id}/test` | Send test delivery |
| `GET/POST` | `/api/admin/api-keys` | List / create API keys |
| `GET/DELETE` | `/api/admin/api-keys/{id}` | Get / revoke API key |
| `GET` | `/api/admin/uploads` | List uploaded files |
| `DELETE` | `/api/admin/uploads/{id}` | Delete an upload |
| `GET` | `/api/admin/notifications` | List notifications |
| `POST` | `/api/admin/notifications` | Create a notification |
| `GET/PUT` | `/api/admin/profile` | Get / update own admin profile |
| `PUT` | `/api/admin/profile/password` | Change own password |
| `GET` | `/api/admin/routes` | List all registered routes |
| `GET` | `/api/admin/metrics` | Prometheus metrics |
| `GET` | `/api/health` | Health check (version, uptime, memory) |

### User endpoints

All user endpoints (except auth) require an authenticated user session.

| Method | Path | Purpose |
|--------|------|---------|
| `GET/PUT` | `/api/user/profile` | Get / update own profile |
| `PUT` | `/api/user/profile/password` | Change own password |
| `GET/PUT` | `/api/user/settings` | Get / update user settings (key-value) |
| `GET` | `/api/user/activity` | Own activity log |
| `GET/POST` | `/api/user/api-keys` | List / create personal API keys |
| `DELETE` | `/api/user/api-keys/{id}` | Revoke own API key |
| `POST` | `/api/user/uploads` | Upload a file |
| `GET` | `/api/user/uploads` | List own uploads |
| `DELETE` | `/api/user/uploads/{id}` | Delete own upload |
| `GET` | `/api/user/notifications` | List own notifications |
| `PUT` | `/api/user/notifications/{id}/read` | Mark notification as read |

---

## Local development with go.work

When you need to develop your app against a local copy of the framework (e.g., to add a framework feature or debug an issue), use a `go.work` file:

```shell
# From your project root (parent of api/)
cat > go.work << 'EOF'
go 1.26.1

use (
    ./api
    ../path/to/framework
)
EOF
```

With `go.work` in place, Go resolves `github.com/stanza-go/framework` from the local directory instead of the module cache. Changes to the framework are picked up immediately — no need to tag or publish.

{% callout title="go.work is local only" %}
Add `go.work` and `go.work.sum` to `.gitignore`. The workspace file is for local development — CI and production use the published module version from `go.mod`.
{% /callout %}

When you're done and want to use the published framework version again, simply delete the `go.work` file.

---

## What to change — checklist

1. **Module path** in `api/go.mod` + all `import` statements
2. **Data directory name** in `api/datadir/datadir.go`
3. **App name** in health check and metadata
4. **Auth signing key** — set `STANZA_AUTH_SIGNING_KEY` for persistent sessions
5. **CORS origins** — update when your frontend runs on a different domain
6. **Email config** — set Resend API key and from address when ready
