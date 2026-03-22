---
title: User API keys
nextjs:
  metadata:
    title: User API keys
    description: How to let end users create and manage their own API keys for programmatic access.
---

The standalone app includes user-facing API key management. Users can create personal API keys to access `/api/user/*` endpoints programmatically — useful for CLI tools, scripts, or third-party integrations. This recipe shows how the module works and how to use it.

---

## How it works

User API keys share the same `api_keys` table as admin keys, distinguished by `entity_type="user"` and `entity_id=userID`. This polymorphic approach follows the same pattern used by uploads and notifications.

Key characteristics:

- Keys are `stza_`-prefixed (e.g., `stza_a1b2c3d4...`) and shown only once at creation
- The key is SHA256-hashed for storage — the raw key cannot be recovered
- All user keys get a fixed `scopes="user"` — no custom scopes, since the user endpoint group uses a single `"user"` scope
- User routes accept both JWT cookies and `Bearer` token authentication via the `RequireAuthOrAPIKey` middleware

---

## API endpoints

```
GET    /api/user/api-keys      — list user's API keys (paginated, searchable)
POST   /api/user/api-keys      — create a new API key (returns full key once)
PUT    /api/user/api-keys/{id} — update key name
DELETE /api/user/api-keys/{id} — revoke an API key (soft delete)
```

All endpoints require authentication with the `"user"` scope.

---

## Creating a key

```bash
curl -X POST http://localhost:23710/api/user/api-keys \
  -H "Content-Type: application/json" \
  -b "access_token=..." \
  -d '{
    "name": "CI Pipeline",
    "expires_at": "2027-01-01T00:00:00Z"
  }'
```

Response:

```json
{
  "api_key": {
    "id": 1,
    "name": "CI Pipeline",
    "key": "stza_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    "key_prefix": "stza_a1b2c3d4",
    "expires_at": "2027-01-01T00:00:00Z",
    "created_at": "2026-03-22T10:00:00Z"
  }
}
```

The full `key` value is returned **only at creation**. Store it securely — subsequent API responses show only the `key_prefix`.

---

## Using a key

Pass the key as a Bearer token:

```bash
curl http://localhost:23710/api/user/profile \
  -H "Authorization: Bearer stza_a1b2c3d4..."
```

The framework's API key validator looks up the key by hash, checks expiration, increments `request_count` and `last_used_at`, and produces `Claims{UID: userID, Scopes: ["user"]}` — identical to what JWT auth produces. Your handler code doesn't need to know which auth method was used.

---

## Listing keys

```bash
curl http://localhost:23710/api/user/api-keys?search=CI&limit=10&offset=0 \
  -b "access_token=..."
```

Response:

```json
{
  "api_keys": [
    {
      "id": 1,
      "name": "CI Pipeline",
      "key_prefix": "stza_a1b2c3d4",
      "request_count": 42,
      "last_used_at": "2026-03-22T12:30:00Z",
      "expires_at": "2027-01-01T00:00:00Z",
      "created_at": "2026-03-22T10:00:00Z",
      "revoked_at": ""
    }
  ],
  "total": 1
}
```

Search matches against both `name` and `key_prefix`.

---

## Revoking a key

```bash
curl -X DELETE http://localhost:23710/api/user/api-keys/1 \
  -b "access_token=..."
```

Revocation is a soft delete — the `revoked_at` timestamp is set and the key stops working. Revoked keys still appear in the list for reference but can't be updated or used for authentication.

---

## Wiring

The module is registered on the user route group in `main.go`:

```go
import "github.com/stanza-go/standalone/module/userapikeys"

userapikeys.Register(user, db)
```

The `user` group already has `RequireAuthOrAPIKey` middleware applied, so all user endpoints accept both JWT and API key authentication automatically.

---

## Tips

- **Key prefix for identification.** The `key_prefix` (first 13 characters: `stza_` + 8 hex chars) is stored separately so users can identify their keys without exposing the full secret.
- **Optional expiration.** The `expires_at` field is optional. Keys without an expiration date live until explicitly revoked.
- **No audit logging.** User API key operations don't trigger admin audit logging — they're self-service actions. Admin API key management (under `/api/admin/api-keys`) does log to the audit trail.
- **Admin visibility.** Admins can see all API keys (including user keys) through the admin API key management module. The admin view includes `entity_type` and `entity_id` fields that the user view omits.
- **Request tracking.** Each key tracks `request_count` and `last_used_at` automatically, giving users visibility into how their keys are being used.
