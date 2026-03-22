---
title: Getting started
---

One binary. One SQLite file. One data dir. Four hours to production. {% .lead %}

{% quick-links %}

{% quick-link title="Installation" icon="installation" href="/docs/installation" description="Fork the standalone repo, install dependencies, and start building in minutes." /%}

{% quick-link title="Lifecycle & DI" icon="presets" href="/docs/lifecycle" description="Dependency injection, startup/shutdown orchestration, and service wiring." /%}

{% quick-link title="HTTP routing" icon="plugins" href="/docs/http" description="Router, middleware, route groups, request parsing, and JSON responses." /%}

{% quick-link title="SQLite database" icon="theming" href="/docs/sqlite" description="Vendored SQLite with CGo bindings, query builder, migrations, and transactions." /%}

{% /quick-links %}

Stanza is an AI-native, batteries-included Go framework for developers who spin up ideas fast, test them with real users, and tear them down if they don't work. It targets single-container deployments serving hundreds to thousands of users.

---

## Philosophy

Every package is built in-house on top of Go's standard library. No GORM, no Chi, no Cobra. Even the SQLite driver is built from the vendored amalgamation via CGo. One process, one binary, one SQLite file.

The framework is designed so AI agents can read the existing code, understand the patterns, and produce correct, idiomatic code on the first try. What makes the AI most comfortable and productive is the right choice.

---

## Architecture

Stanza is split across four repositories under the `stanza-go` GitHub organization:

| Repo | Purpose |
|------|---------|
| `framework` | The engine — Go packages under `pkg/`, zero external dependencies |
| `standalone` | A fully built application you fork and customize |
| `cli` | CLI tool for project management (`stanza export`, `stanza import`) |
| `docs` | This documentation site |

The `standalone` repo contains three projects:

| Project | Dev Port | Stack |
|---------|----------|-------|
| `api/` | 23710 | Go + Stanza framework |
| `ui/` | 23700 | Vite + Bun — blank canvas for your frontend |
| `admin/` | 23706 | Vite + Bun + React + Mantine — pre-built admin panel |

In production, both frontends are embedded into the Go binary via `//go:embed`. One binary serves everything.

---

## What's included

When you fork `standalone`, this already works:

- **Auth** — JWT access tokens, refresh tokens, password hashing, API key authentication
- **Admin panel** — Dashboard, user management, sessions, API keys, cron monitoring, job queue, log viewer, database admin, settings
- **Background processing** — SQLite-backed job queue with in-process workers, cron scheduler
- **Infrastructure** — Auto-run migrations with backup, structured JSON logging, layered configuration, lifecycle orchestration
- **Deploy** — Multi-stage Dockerfile (~20MB image), Railway config, single binary

---

## Developer workflow

```shell
# Fork and clone
git clone https://github.com/your-org/standalone
cd standalone

# Start all three projects with hot reload
make dev

# Build your idea — AI does the heavy lifting

# Build a single production binary
make build

# Deploy anywhere
docker push && railway up
```
