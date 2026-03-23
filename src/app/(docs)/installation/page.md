---
title: Installation
nextjs:
  metadata:
    title: Installation
    description: Fork the standalone repo, install dependencies, and start building.
---

Stanza requires Go 1.26+ and Bun (for frontend tooling). The standalone repo is the starting point — fork it, clone it, and you're ready to build.

---

## Prerequisites

- **Go 1.26.1+** — [go.dev/dl](https://go.dev/dl/)
- **Bun** — [bun.sh](https://bun.sh/) (for frontend dev and builds)
- **GCC or Clang** — Required for CGo (SQLite is compiled from vendored C source)

On macOS, Xcode Command Line Tools includes Clang. On Linux, install `gcc` or `build-essential`.

---

## Fork and clone

```shell
# Fork stanza-go/standalone on GitHub, then:
git clone https://github.com/your-org/standalone
cd standalone
```

The standalone repo contains three projects:

```
standalone/
├── api/        ← Go backend (port 23710)
├── admin/      ← React admin panel (port 23706)
├── ui/         ← Blank frontend canvas (port 23700)
├── Makefile
└── Dockerfile
```

---

## Install dependencies

```shell
# Install Go dependencies (includes CGo compilation of SQLite)
cd api && go mod download && cd ..

# Install frontend dependencies
cd admin && bun install && cd ..
cd ui && bun install && cd ..
```

---

## Start development

```shell
make dev
```

This starts three processes with hot reload:

| Process | URL | What it does |
|---------|-----|------|
| API | `http://localhost:23710` | Go server with file watcher |
| Admin | `http://localhost:23706` | Vite dev server (proxies `/api/*` to Go) |
| UI | `http://localhost:23700` | Vite dev server (proxies `/api/*` to Go) |

On first boot, the API server will:

1. Create the data directory at `~/.stanza/`
2. Create `database.sqlite` with WAL mode enabled
3. Run all pending migrations
4. Seed the default admin user: `admin@stanza.dev` / `admin`

{% callout title="Secure cookies" %}
For local development, set `STANZA_AUTH_SECURE_COOKIES=false` in your environment. Without this, auth cookies won't be sent over plain HTTP.
{% /callout %}

---

## Build for production

```shell
make build
```

This produces a single binary (~10MB) with both frontends embedded:

| Path | Serves |
|------|--------|
| `/*` | Embedded UI (SPA with client-side routing) |
| `/admin/*` | Embedded admin panel |
| `/api/*` | Go API handlers |

---

## Deploy

The repo includes a multi-stage Dockerfile:

```shell
# Build the image (from project root)
docker build -t my-app .

# Run it
docker run -p 23710:23710 -v app-data:/data my-app
```

The `DATA_DIR` environment variable controls where the database and logs are stored. Set it to your persistent volume mount point in production.

---

## Project structure

### API (`api/`)

```
api/
├── main.go              ← DI wiring, route registration, lifecycle
├── module/
│   ├── health/          ← Health check (version, uptime, memory)
│   ├── dashboard/       ← System stats and charts
│   ├── adminauth/       ← Admin login/logout/status
│   ├── adminusers/      ← Admin user CRUD
│   ├── adminroles/      ← Roles and scopes management
│   ├── adminsessions/   ← Session management
│   ├── adminaudit/      ← Audit log viewer
│   ├── admincron/       ← Cron monitoring
│   ├── adminqueue/      ← Queue monitoring
│   ├── adminlogs/       ← Log viewer
│   ├── admindb/         ← Database admin and backups
│   ├── adminsettings/   ← Settings management
│   ├── adminprofile/    ← Admin profile and password
│   ├── adminuploads/    ← Upload management
│   ├── adminwebhooks/   ← Webhook management
│   ├── adminnotifications/ ← Admin notification management
│   ├── usermgmt/        ← End-user management
│   ├── userauth/        ← User register/login/logout
│   ├── userprofile/     ← User profile endpoint
│   ├── userreset/       ← Password reset flow
│   ├── usersettings/    ← User settings key-value store
│   ├── useractivity/    ← User activity log
│   ├── userapikeys/     ← User API key management
│   ├── useruploads/     ← User file uploads
│   ├── usernotifications/ ← User notification endpoints
│   ├── apikeys/         ← API key CRUD + validator
│   ├── webhooks/        ← Webhook delivery engine
│   └── notifications/   ← Notification system
├── migration/           ← Database migrations
├── datadir/             ← Data directory resolver
└── seed/                ← Default data seeding
```

Each module follows the same pattern: `api/module/{name}/{name}.go` with a `Register(group, deps...)` function. The AI reads existing modules as reference and creates new ones the same way.

### Admin (`admin/`)

A React + Mantine app with pre-built pages for every admin feature. Modules are self-contained under `src/pages/`.

### UI (`ui/`)

A blank canvas — a single HTML file served by Vite. No framework, no opinions. Build whatever your idea demands.
