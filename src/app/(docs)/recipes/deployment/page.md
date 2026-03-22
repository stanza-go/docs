---
title: Deployment
nextjs:
  metadata:
    title: Deployment
    description: How to build, containerize, and deploy a Stanza app to Railway, Cloud Run, or any container platform.
---

A Stanza app compiles to a single binary with everything embedded — both frontends, migrations, cron jobs, and the job queue. Deploy it anywhere that runs containers. This recipe covers building, Docker, and deploying to Railway.

---

## Production build

Build a single binary with both frontends embedded:

```bash
cd standalone
make build
```

This runs three steps in sequence:
1. `make build-ui` — builds the UI frontend with Vite/Bun
2. `make build-admin` — builds the admin panel with Vite/Bun
3. `make build-api` — compiles Go with `CGO_ENABLED=1` and `-tags prod`

Output: `api/bin/standalone` (~10MB with embedded admin panel, boots in <100ms).

The `-tags prod` flag activates `//go:embed` directives that bundle the frontend `dist/` directories into the binary. In development mode (without the tag), the frontends are served by their own Vite dev servers.

The build also injects metadata via `-ldflags`: version (from `git describe`), commit SHA, and build timestamp. The health endpoint reports these fields so you can verify which build is deployed:

```bash
curl https://your-app.up.railway.app/api/health
# {"status":"ok","version":"v0.1.0","commit":"abc1234","build_time":"2026-03-22T08:28:42Z",...}
```

---

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Server port (Railway, Cloud Run set this automatically) | `23710` |
| `DATA_DIR` | Persistent data directory | `~/.stanza/` |
| `STANZA_SERVER_ADDR` | Explicit listen address (overrides PORT) | `:23710` |
| `STANZA_AUTH_SIGNING_KEY` | JWT signing key (must be persistent across restarts) | Random (changes on restart) |
| `STANZA_AUTH_SECURE_COOKIES` | Set to `false` for local dev without HTTPS | `true` |
| `STANZA_EMAIL_RESEND_API_KEY` | Resend API key for transactional email | — |
| `STANZA_EMAIL_FROM` | Sender address for emails | `noreply@stanza.dev` |

**Critical:** Set `STANZA_AUTH_SIGNING_KEY` to a stable secret in production. Without it, the key is randomly generated on each boot — every restart invalidates all JWT tokens and logs out all users.

---

## Data directory

All persistent state lives in one directory:

```
/data/                    ← DATA_DIR in Docker, ~/.stanza/ locally
├── database.sqlite       ← all data (WAL mode)
├── logs/                 ← rotated structured logs
├── uploads/              ← user files (YYYY/MM/DD/{UUID}/filename)
├── backups/              ← auto-backup before migrations
└── config.yaml           ← runtime configuration overrides
```

The binary is stateless — the data directory is the only thing you need to back up, migrate, or persist.

---

## Docker

### Build the image

Run from the **workspace root** (not from `standalone/`), because the Dockerfile needs both `framework/` and `standalone/`:

```bash
docker build -t stanza -f standalone/Dockerfile .
```

The Dockerfile uses a 3-stage build:
1. **Frontend stage** (bun) — builds UI and admin dist bundles
2. **Backend stage** (golang:alpine) — compiles Go binary with CGO for SQLite, injects build metadata
3. **Runtime stage** (alpine:3.21) — minimal image with the binary

The runtime image is ~12MB, runs as a non-root `stanza` user via `su-exec`, and sets `DATA_DIR=/data`.

### Run locally

```bash
docker run -p 23710:23710 \
  -v stanza-data:/data \
  -e STANZA_AUTH_SIGNING_KEY=your-secret-key \
  -e STANZA_AUTH_SECURE_COOKIES=false \
  stanza
```

### What happens on startup

1. The entrypoint `chown`s `/data` to the `stanza` user (handles volume permission issues)
2. Drops privileges via `su-exec` to run the binary as `stanza`
3. The app resolves `DATA_DIR`, creates subdirectories if needed
4. Migrations run automatically (with auto-backup of the SQLite file)
5. Cron scheduler and job queue workers start
6. HTTP server begins listening

---

## Railway

### Initial setup

1. Create a new project on [Railway](https://railway.com)
2. Link your repo (or use `railway link` from the workspace root)
3. Add a **persistent volume** mounted at `/data` — this stores your SQLite database, logs, and uploads

### Configuration

The `railway.toml` at the workspace root configures the build:

```toml
[build]
dockerfilePath = "standalone/Dockerfile"

[deploy]
healthcheckPath = "/api/health"
restartPolicyType = "on_failure"
```

Railway automatically sets the `PORT` environment variable. The app detects it and binds to `0.0.0.0:{PORT}`.

### Required environment variables

Set these in the Railway dashboard (Settings → Variables):

```
STANZA_AUTH_SIGNING_KEY=<generate a random 32+ char secret>
```

### Optional environment variables

```
STANZA_EMAIL_RESEND_API_KEY=re_...
STANZA_EMAIL_FROM=App Name <onboarding@resend.dev>
```

### Deploy

```bash
railway up
```

Or push to your linked branch — Railway auto-deploys on push.

### Verify

```bash
# Health check
curl https://your-app.up.railway.app/api/health

# Admin panel
open https://your-app.up.railway.app/admin/

# Default admin credentials (change immediately)
# admin@stanza.dev / admin
```

---

## Cloud Run

Cloud Run works with the same Docker image. Key differences from Railway:

- Cloud Run sets `PORT` automatically — the app handles this
- Use a **persistent volume** or **Cloud Storage FUSE** for `/data`
- Set `DATA_DIR` to your mount path

```bash
# Build and push
docker build -t gcr.io/PROJECT/stanza -f standalone/Dockerfile .
docker push gcr.io/PROJECT/stanza

# Deploy
gcloud run deploy stanza \
  --image gcr.io/PROJECT/stanza \
  --set-env-vars STANZA_AUTH_SIGNING_KEY=your-secret \
  --set-env-vars DATA_DIR=/data \
  --port 23710
```

**Important:** Cloud Run scales to zero by default. This means cold starts (~100ms for the binary, plus migration check). For always-on behavior, set minimum instances to 1.

---

## Any container platform

The deployment pattern is the same everywhere:

1. Build the Docker image from the workspace root
2. Mount a persistent volume at `/data` (or set `DATA_DIR`)
3. Set `STANZA_AUTH_SIGNING_KEY` to a stable secret
4. The platform sets `PORT` — the app reads it automatically
5. Health check endpoint: `GET /api/health`

---

## Backup and restore

Since everything is in one directory, backup is trivial:

```bash
# Database backup (consistent, compacted via VACUUM INTO)
stanza backup

# Compressed database backup (~10x smaller)
stanza backup --compress

# Full data directory export (database + logs + uploads + config)
stanza export

# Restore from export
stanza import backup.zip
```

The `stanza backup` command uses `VACUUM INTO` for a consistent, compacted copy of just the database — safe to run while the app is live. Use `stanza export` when you need everything (uploads, logs, config). The app also creates automatic SQLite backups before running migrations.

---

## Tips

- **Always set `STANZA_AUTH_SIGNING_KEY`.** Without it, JWT tokens invalidate on every restart. Generate one with `openssl rand -hex 32`.
- **Volume is mandatory.** Without persistent storage at `/data`, you lose your database, uploads, and logs on every deploy.
- **Build from workspace root.** The Dockerfile references both `framework/` and `standalone/` via Go's `replace` directive. Building from `standalone/` alone will fail.
- **Migrations are automatic.** No manual migration step needed. The app runs pending migrations on every boot with an auto-backup beforehand.
- **Default admin credentials.** The seed creates `admin@stanza.dev` / `admin`. Change the password immediately after first deploy.
- **HTTPS.** Railway and Cloud Run provide HTTPS automatically. The app sets `Secure` and `SameSite=Lax` on auth cookies by default — this requires HTTPS. For local Docker testing without HTTPS, set `STANZA_AUTH_SECURE_COOKIES=false`.
- **HSTS.** When the `PORT` environment variable is set (Railway, Cloud Run), the app automatically enables `Strict-Transport-Security` headers. This tells browsers to always use HTTPS. Not set in local development.
