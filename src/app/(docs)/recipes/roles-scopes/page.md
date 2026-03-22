---
title: Roles & scopes
nextjs:
  metadata:
    title: Roles & scopes
    description: How to manage admin roles, define scopes, and enforce permissions.
---

The standalone app includes a database-driven roles and scopes system. Roles group permissions (scopes) together, and scopes control access to specific admin features. This recipe covers role management, scope enforcement, and how roles flow into JWT tokens.

---

## How it works

1. **Roles** are stored in the `roles` table. Each role has a name and a set of scopes.
2. **Scopes** are stored in `role_scopes` — one row per scope per role.
3. When an admin **logs in**, their role's scopes are fetched and embedded in the JWT access token.
4. **Middleware** checks the JWT scopes on every request — no database lookup needed.
5. When scopes change, the admin's **next token refresh** (~1 minute) picks up the new scopes automatically.

---

## Built-in scopes

| Scope | Controls |
|-------|----------|
| `admin` | Base admin panel access (always required) |
| `admin:users` | User management |
| `admin:settings` | Application settings |
| `admin:jobs` | Cron scheduler and job queue |
| `admin:logs` | Log viewer |
| `admin:audit` | Audit log |
| `admin:uploads` | Upload management |
| `admin:database` | Database admin (download, backup) |
| `admin:roles` | Role management |
| `admin:notifications` | Notification management |

---

## System roles

Three roles are seeded on first boot:

| Role | Scopes | Purpose |
|------|--------|---------|
| **superadmin** | All 10 scopes | Full access to everything |
| **admin** | `admin`, `admin:users`, `admin:settings` | Day-to-day admin work |
| **viewer** | `admin` | Read-only dashboard access |

System roles cannot be deleted or renamed, but their scopes **can** be modified. This lets you temporarily restrict features without creating new roles.

---

## Migration

The roles system uses two tables created in a single migration:

```go
func (m *CreateRoles) Up(db *sqlite.DB) error {
    _, err := db.Exec(`CREATE TABLE roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    if err != nil {
        return err
    }

    _, err = db.Exec(`CREATE TABLE role_scopes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        UNIQUE(role_id, scope)
    )`)
    if err != nil {
        return err
    }

    _, err = db.Exec(`CREATE INDEX idx_role_scopes_role_id ON role_scopes(role_id)`)
    return err
}
```

The seed data (three system roles + their scopes) is inserted in the same migration using `INSERT OR IGNORE` for idempotency.

---

## API endpoints

All endpoints require admin authentication. Role management endpoints additionally require the `admin:roles` scope.

```
GET    /api/admin/roles          — list all roles with scopes and admin count
POST   /api/admin/roles          — create a custom role
PUT    /api/admin/roles/{id}     — update role name, description, or scopes
DELETE /api/admin/roles/{id}     — delete a custom role
GET    /api/admin/roles/scopes   — list all known scopes
GET    /api/admin/role-names     — list role names (for dropdowns)
```

### Create a role

```bash
curl -X POST /api/admin/roles \
  -H "Cookie: access_token=..." \
  -d '{"name": "editor", "description": "Content editors", "scopes": ["admin:users", "admin:uploads"]}'
```

The `admin` base scope is automatically included — you don't need to specify it.

### Update scopes

```bash
curl -X PUT /api/admin/roles/4 \
  -H "Cookie: access_token=..." \
  -d '{"scopes": ["admin:users", "admin:uploads", "admin:notifications"]}'
```

For system roles, only scopes and description can be changed. The name is immutable.

### Delete a role

```bash
curl -X DELETE /api/admin/roles/4 \
  -H "Cookie: access_token=..."
```

Returns 400 for system roles. Returns 409 if any active admins are assigned to the role — reassign them first.

---

## Enforcing scopes in your modules

Use `auth.RequireScope` middleware to protect routes:

```go
func Register(group *http.Group, db *sqlite.DB, a *auth.Auth) {
    g := group.Group("/groomers")
    g.Use(a.RequireAuth())

    // All routes require admin:users scope
    g.Use(auth.RequireScope("admin:users"))

    g.Handle("GET /", listGroomersHandler(db))
    g.Handle("POST /", createGroomerHandler(db))
}
```

Or protect individual routes:

```go
func Register(group *http.Group, db *sqlite.DB, a *auth.Auth) {
    g := group.Group("/reports")
    g.Use(a.RequireAuth())

    // Anyone with base admin access can view
    g.Handle("GET /", listReportsHandler(db))

    // Only admins with admin:settings can export
    g.Handle("POST /export", auth.RequireScope("admin:settings")(exportReportsHandler(db)))
}
```

When a request lacks the required scope, the middleware returns `403 Forbidden`:

```json
{"error": "Forbidden: missing required scope"}
```

---

## How scopes flow into JWT tokens

### Login

```
Admin submits email + password
    ↓
Look up admin record (includes role name)
    ↓
Query role_scopes for that role → ["admin", "admin:users", ...]
    ↓
Issue JWT access token with scopes embedded in claims
    ↓
Set access token + refresh token as HttpOnly cookies
```

### Token refresh (~1 minute polling)

```
Frontend calls GET /api/admin/auth
    ↓
Validate refresh token against DB
    ↓
Re-fetch current scopes for admin's role   ← picks up any changes
    ↓
Issue fresh access token with updated scopes
```

This means scope changes take effect within ~1 minute for active sessions — no need to force logout.

---

## Assigning roles to admins

Admins have a `role` column that stores the role name as a string:

```go
// In admin creation
func createAdminHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        var req struct {
            Email    string `json:"email"`
            Password string `json:"password"`
            Name     string `json:"name"`
            Role     string `json:"role"`
        }
        // ... parse request ...

        // Validate role exists
        if !adminroles.ValidateRoleExists(db, req.Role) {
            http.WriteJSON(w, http.StatusBadRequest, map[string]any{
                "error": "Invalid role",
            })
            return
        }

        // ... create admin with role ...
    }
}
```

When a custom role is renamed, all admins assigned to it are automatically updated.

---

## Adding custom scopes

To add a new scope:

1. Add it to the `KnownScopes` slice in `module/adminroles/adminroles.go`:

```go
var KnownScopes = []string{
    "admin",
    "admin:users",
    "admin:settings",
    // ... existing scopes ...
    "admin:groomers",  // your new scope
}
```

2. Assign it to roles via the admin panel or API.

3. Enforce it in your module with `auth.RequireScope("admin:groomers")`.

The naming convention is `admin:{feature}` — always prefixed with `admin:` for admin panel scopes.

---

## Admin panel UI

The admin panel includes a **Roles** page at `/admin/roles` with:

- **Role table** — name, description, scopes (color-coded badges), admin count
- **Create role** dialog — name, description, and scope checkboxes
- **Edit role** dialog — modify scopes (system role names are read-only)
- **Delete** — with confirmation, blocked if admins are assigned

The `admin` (Base Access) scope is always checked and disabled in the checkbox list — it cannot be removed from any role.

---

## Tips

- **Base scope is automatic.** The `admin` scope is always included when creating or updating a role. You never need to add it manually.
- **Scope changes propagate fast.** The frontend polls the auth status endpoint every ~1 minute. Changed scopes appear in the next refresh — no logout needed.
- **System roles are safe to modify.** You can add or remove scopes from superadmin, admin, and viewer roles. Only their names are immutable.
- **Validate before assigning.** Use `adminroles.ValidateRoleExists(db, role)` before storing a role name on an admin. This prevents orphaned role references.
- **Role binding is by name.** The `admins.role` column stores the role name as a string, not a foreign key. Custom role renames cascade automatically to all assigned admins.
- **Delete requires zero admins.** A role can only be deleted if no active admins are assigned to it. Reassign admins to a different role first.
