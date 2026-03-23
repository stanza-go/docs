---
title: File uploads
nextjs:
  metadata:
    title: File uploads
    description: How to handle file uploads with automatic thumbnail generation and per-user isolation.
---

The standalone app includes complete file upload management for both admins and end users. Files are stored on disk with automatic thumbnail generation for images. This recipe covers the upload pattern and how to add uploads to your modules.

---

## Storage layout

Files are stored under the data directory:

```
{DATA_DIR}/uploads/
├── 2026/
│   └── 03/
│       └── 21/
│           ├── a1b2c3d4.../
│           │   ├── photo.jpg         ← original file
│           │   └── thumbnail.jpg     ← auto-generated (images only)
│           └── e5f6g7h8.../
│               └── report.pdf
```

Each upload gets a unique UUID directory under a date-based path (`YYYY/MM/DD/{UUID}/filename`). This prevents filename collisions and makes backup/cleanup straightforward.

---

## API endpoints

### Admin uploads

Admins can see and manage all uploads regardless of owner:

```
POST   /api/admin/uploads            — upload a file (multipart, 50MB max)
GET    /api/admin/uploads            — list all uploads (paginated, filterable)
GET    /api/admin/uploads/{id}       — get upload metadata
DELETE /api/admin/uploads/{id}       — soft-delete
GET    /api/admin/uploads/{id}/file  — serve original file
GET    /api/admin/uploads/{id}/thumb — serve thumbnail (images only)
```

### User uploads

Users can only access their own uploads:

```
POST   /api/user/uploads            — upload a file
GET    /api/user/uploads            — list own uploads (paginated)
GET    /api/user/uploads/{id}       — get own upload metadata
DELETE /api/user/uploads/{id}       — soft-delete own upload
GET    /api/user/uploads/{id}/file  — serve own original file
GET    /api/user/uploads/{id}/thumb — serve own thumbnail
```

---

## Uploading a file

Upload via multipart form data with a `file` field:

```bash
curl -X POST http://localhost:23710/api/admin/uploads \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@photo.jpg" \
  -F "entity_type=product" \
  -F "entity_id=42"
```

Response:

```json
{
  "upload": {
    "id": 1,
    "uuid": "a1b2c3d4e5f6...",
    "original_name": "photo.jpg",
    "content_type": "image/jpeg",
    "size_bytes": 245760,
    "has_thumbnail": true,
    "entity_type": "product",
    "entity_id": "42",
    "created_at": "2026-03-21T10:30:00Z"
  }
}
```

Optional form fields `entity_type` and `entity_id` let you associate the upload with a specific entity (product, user, order, etc.).

---

## Thumbnail generation

Thumbnails are automatically generated for JPEG, PNG, and GIF images:

- **Max dimension:** 300px (width or height, preserving aspect ratio)
- **Algorithm:** Nearest-neighbor resize (fast, Go stdlib only)
- **Format:** JPEG at quality 80
- **Storage:** `thumbnail.jpg` in the same UUID directory as the original

Thumbnails are served with a 24-hour `Cache-Control` header.

---

## Per-user isolation

User uploads are scoped via `entity_type="user"` and `entity_id` set to the authenticated user's ID. All user upload endpoints filter by these fields, so users can never access another user's uploads.

```go
// User upload endpoints add these filters automatically:
q.Where("entity_type = ?", "user")
q.Where("entity_id = ?", sqlite.FormatID(userID))
```

---

## Filtering uploads

The list endpoints support query parameters:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `limit` | Results per page | `?limit=20` |
| `offset` | Skip N results | `?offset=40` |
| `content_type` | Filter by MIME type prefix | `?content_type=image` |
| `entity_type` | Filter by entity type (admin only) | `?entity_type=product` |
| `include_deleted` | Include soft-deleted uploads (admin only) | `?include_deleted=true` |

---

## Database schema

```sql
CREATE TABLE uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    storage_path TEXT NOT NULL,
    has_thumbnail INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT NOT NULL DEFAULT '',
    entity_type TEXT NOT NULL DEFAULT '',
    entity_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);
```

---

## Adding uploads to a custom module

Link uploads to your entities using `entity_type` and `entity_id`:

```go
// Upload a product image
// POST /api/admin/uploads with entity_type=product, entity_id=42

// Query uploads for a specific product
sql, args := sqlite.Select("id", "uuid", "original_name", "content_type", "has_thumbnail").
    From("uploads").
    Where("entity_type = ?", "product").
    Where("entity_id = ?", productID).
    WhereNull("deleted_at").
    OrderBy("created_at", "DESC").
    Build()
```

---

## Admin panel UI

The admin panel includes an uploads management page at `/admin/uploads` with:

- Table with thumbnail preview, file name, type, size, owner, and upload date
- File type filter buttons (All, Images, Videos, PDFs)
- "Show deleted" toggle
- Preview dialog for images and videos with full metadata
- Download links and soft-delete with confirmation

---

## Tips

- **50MB limit.** The max upload size is 50MB, set via `MaxBytesReader`. Adjust the `maxUploadSize` constant for larger files.
- **Soft delete.** Deleted uploads are marked with a `deleted_at` timestamp but the files remain on disk. Implement a cleanup cron if you need to reclaim disk space.
- **Content type detection.** MIME types are detected from the file extension, not the file content. This is simpler and covers the common cases.
- **No CDN.** Files are served directly from the Go binary. For high-traffic apps, put a CDN (Cloudflare, CloudFront) in front.
