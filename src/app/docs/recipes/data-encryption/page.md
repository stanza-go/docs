---
title: Data encryption
nextjs:
  metadata:
    title: Data encryption
    description: How to encrypt sensitive fields at rest in SQLite using AES-256-GCM with Go's standard library.
---

Some data — social security numbers, tax IDs, bank accounts, private notes — must be encrypted at rest. This recipe covers encrypting and decrypting individual model fields using AES-256-GCM with Go's standard library. No external dependencies.

---

## The encryption helper

Create an `encrypt` package in your app with a `Key` type that handles encryption and decryption. Both methods use AES-256-GCM (authenticated encryption) and produce base64 strings for SQLite TEXT storage:

```go
// encrypt/encrypt.go
package encrypt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
)

// Key is a 32-byte AES-256 encryption key.
type Key [32]byte

// ParseKey decodes a 64-character hex string into a Key.
func ParseKey(s string) (Key, error) {
	var k Key
	b, err := hex.DecodeString(s)
	if err != nil {
		return k, errors.New("encryption key must be hex-encoded")
	}
	if len(b) != 32 {
		return k, errors.New("encryption key must be 32 bytes (64 hex characters)")
	}
	copy(k[:], b)
	return k, nil
}

// Encrypt encrypts plaintext with AES-256-GCM. Returns a base64 string
// for storage in a SQLite TEXT column. Each call produces unique output
// because a fresh random nonce is generated every time.
func (k Key) Encrypt(plaintext string) (string, error) {
	block, err := aes.NewCipher(k[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// Decrypt decodes base64 and decrypts with AES-256-GCM.
func (k Key) Decrypt(encoded string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(k[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	plaintext, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
	if err != nil {
		return "", errors.New("decryption failed: invalid key or corrupted data")
	}
	return string(plaintext), nil
}
```

The `Key` type enforces the correct 32-byte size at compile time. `Encrypt` prepends the random nonce to the ciphertext before base64 encoding, so `Decrypt` can extract it without external state.

{% callout title="AES-GCM" %}
AES-GCM provides both confidentiality and integrity. If anyone tampers with the ciphertext, `Decrypt` returns an error instead of corrupted data. On modern CPUs with AES-NI instructions, encryption and decryption add negligible overhead.
{% /callout %}

---

## Wiring the encryption key

Generate a key with OpenSSL:

```bash
openssl rand -hex 32
# e.g. 4f3c2b1a9e8d7f6054a3b2c1d0e9f8a74f3c2b1a9e8d7f6054a3b2c1d0e9f8a7
```

Set it as an environment variable:

```bash
# .env / Railway / Cloud Run
STANZA_ENCRYPTION_KEY=4f3c2b1a9e8d7f6054a3b2c1d0e9f8a74f3c2b1a9e8d7f6054a3b2c1d0e9f8a7
```

Wire it through the DI container in `main.go`:

```go
func provideConfig() *config.Config {
	cfg := config.New(config.WithEnvPrefix("STANZA"))

	// ... existing defaults ...

	// Encryption — required in production, optional in development.
	cfg.SetDefault("encryption.key", "")

	return cfg
}

func provideEncryptionKey(cfg *config.Config) encrypt.Key {
	raw := cfg.Get("encryption.key")
	if raw == "" {
		// Generate a random key for development.
		// Data encrypted with this key is lost on restart.
		var k encrypt.Key
		_, _ = rand.Read(k[:])
		return k
	}
	key, err := encrypt.ParseKey(raw)
	if err != nil {
		panic("invalid STANZA_ENCRYPTION_KEY: " + err.Error())
	}
	return key
}
```

Inject the key into modules that need it:

```go
func registerModules(router *http.Router, db *sqlite.DB, key encrypt.Key) {
	api := router.Group("/api")

	customers.Register(api.Group("/customers"), db, key)
	// ... other modules ...
}
```

{% callout title="Never log the key" type="warning" %}
The encryption key is the most sensitive secret in your application. Never log it, never include it in error messages, and never commit it to version control. Treat it like a database password — store it in your deployment platform's secret management.
{% /callout %}

---

## Schema for encrypted columns

Encrypted fields are stored as regular TEXT columns. The encryption is handled in Go, not SQL:

```go
migration.Register(1710900000, migration.Migration{
	Name: "create_customers",
	Up: `CREATE TABLE customers (
		id         INTEGER PRIMARY KEY,
		name       TEXT NOT NULL,
		email      TEXT NOT NULL UNIQUE,
		ssn        TEXT NOT NULL DEFAULT '',
		notes      TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
		updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	)`,
})
```

The encrypted columns (`ssn`, `notes`) look like any other TEXT column. The base64 ciphertext is typically 40–60% larger than the plaintext, plus a fixed 28-byte overhead (12-byte nonce + 16-byte GCM authentication tag).

---

## Encrypting on write

Encrypt sensitive fields before INSERT or UPDATE:

```go
func createHandler(db *sqlite.DB, key encrypt.Key) func(w http.ResponseWriter, r *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name  string `json:"name"`
			Email string `json:"email"`
			SSN   string `json:"ssn"`
			Notes string `json:"notes"`
		}
		if err := http.ReadJSON(r, &body); err != nil {
			http.Error(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if err := validate.Fields(
			validate.Required("name", body.Name),
			validate.Email("email", body.Email),
		); err != nil {
			http.WriteValidationError(w, err)
			return
		}

		// Encrypt sensitive fields before storage.
		encSSN, err := key.Encrypt(body.SSN)
		if err != nil {
			http.Error(w, http.StatusInternalServerError, "encryption failed")
			return
		}
		encNotes, err := key.Encrypt(body.Notes)
		if err != nil {
			http.Error(w, http.StatusInternalServerError, "encryption failed")
			return
		}

		sb := sqlite.InsertInto("customers").
			Set("name", body.Name).
			Set("email", body.Email).
			Set("ssn", encSSN).
			Set("notes", encNotes)
		result, err := db.Exec(sb.Build())
		if err != nil {
			http.Error(w, http.StatusInternalServerError, "failed to create customer")
			return
		}

		id, _ := result.LastInsertId()
		http.WriteJSON(w, http.StatusCreated, map[string]int64{"id": id})
	}
}
```

Each call to `Encrypt` generates a fresh random nonce, so encrypting the same plaintext twice produces different ciphertext. This prevents an attacker from detecting duplicate values by comparing stored data.

---

## Decrypting on read

Decrypt after reading from the database. Check for empty strings before decrypting — rows with the default empty value should return empty, not a decryption error:

```go
func getHandler(db *sqlite.DB, key encrypt.Key) func(w http.ResponseWriter, r *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := http.PathParamInt64(w, r, "id")
		if !ok {
			return
		}

		sb := sqlite.Select("id", "name", "email", "ssn", "notes", "created_at").
			From("customers").
			Where("id = ?", id)
		row := db.QueryRow(sb.Build())

		var c struct {
			ID        int64  `json:"id"`
			Name      string `json:"name"`
			Email     string `json:"email"`
			SSN       string `json:"ssn"`
			Notes     string `json:"notes"`
			CreatedAt string `json:"created_at"`
		}
		var encSSN, encNotes string
		if err := row.Scan(&c.ID, &c.Name, &c.Email, &encSSN, &encNotes, &c.CreatedAt); err != nil {
			http.Error(w, http.StatusNotFound, "customer not found")
			return
		}

		// Decrypt sensitive fields.
		if encSSN != "" {
			plain, err := key.Decrypt(encSSN)
			if err != nil {
				http.Error(w, http.StatusInternalServerError, "decryption failed")
				return
			}
			c.SSN = plain
		}
		if encNotes != "" {
			plain, err := key.Decrypt(encNotes)
			if err != nil {
				http.Error(w, http.StatusInternalServerError, "decryption failed")
				return
			}
			c.Notes = plain
		}

		http.WriteJSON(w, http.StatusOK, c)
	}
}
```

---

## Skipping encryption in list endpoints

List endpoints typically don't need sensitive fields. Omit encrypted columns from the SELECT to avoid unnecessary decryption:

```go
func listHandler(db *sqlite.DB) func(w http.ResponseWriter, r *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		page, perPage := http.ParsePagination(r)

		// Only select non-sensitive columns — no ssn, no notes.
		sb := sqlite.Select("id", "name", "email", "created_at").
			From("customers").
			OrderBy("created_at DESC").
			Limit(perPage).
			Offset((page - 1) * perPage)
		rows, err := db.Query(sb.Build())
		if err != nil {
			http.Error(w, http.StatusInternalServerError, "query failed")
			return
		}
		defer rows.Close()

		type item struct {
			ID        int64  `json:"id"`
			Name      string `json:"name"`
			Email     string `json:"email"`
			CreatedAt string `json:"created_at"`
		}
		var items []item
		for rows.Next() {
			var c item
			if err := rows.Scan(&c.ID, &c.Name, &c.Email, &c.CreatedAt); err != nil {
				http.Error(w, http.StatusInternalServerError, "scan failed")
				return
			}
			items = append(items, c)
		}

		total, _ := db.Count(sqlite.CountFrom("customers"))
		http.WriteJSON(w, http.StatusOK, http.PaginatedResponse(items, total, page, perPage))
	}
}
```

The detail endpoint decrypts on demand. The list endpoint stays fast by skipping encryption entirely.

---

## Searching encrypted data

You cannot search or filter encrypted columns with SQL. `WHERE ssn = ?` will not match because the same plaintext produces different ciphertext each time.

**For exact-match lookups**, store a keyed HMAC hash alongside the encrypted value:

```go
// encrypt/encrypt.go

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// Hash creates a deterministic HMAC-SHA256 for exact-match lookups.
// The hash is not reversible — it cannot recover the original value.
func (k Key) Hash(value string) string {
	mac := hmac.New(sha256.New, k[:])
	mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))
}
```

Add an indexed hash column to the schema:

```sql
ALTER TABLE customers ADD COLUMN ssn_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_customers_ssn_hash ON customers(ssn_hash);
```

Compute the hash on write alongside encryption:

```go
encSSN, err := key.Encrypt(body.SSN)
if err != nil {
	http.Error(w, http.StatusInternalServerError, "encryption failed")
	return
}
ssnHash := key.Hash(body.SSN)

sb := sqlite.InsertInto("customers").
	Set("name", body.Name).
	Set("email", body.Email).
	Set("ssn", encSSN).
	Set("ssn_hash", ssnHash).
	Set("notes", encNotes)
```

Query by hash for lookups:

```go
func findBySSN(db *sqlite.DB, key encrypt.Key, ssn string) {
	hash := key.Hash(ssn)
	sb := sqlite.Select("id", "name", "email", "ssn", "created_at").
		From("customers").
		Where("ssn_hash = ?", hash)
	// ...
}
```

The hash is deterministic (same input always produces the same output) but not reversible. An attacker with database access cannot recover the original SSN from the hash.

{% callout title="Partial search" %}
HMAC hashes only support exact matches. If you need to search by a partial value (like the last 4 digits of an SSN), store that specific searchable portion as a separate plaintext column. Only do this with the user's informed consent and a clear understanding of the privacy tradeoff.
{% /callout %}

---

## Key rotation

When the encryption key is compromised or policy requires rotation, re-encrypt all data with a new key. Run this as a one-time operation:

```go
func rotateEncryptionKey(db *sqlite.DB, oldKey, newKey encrypt.Key) error {
	sb := sqlite.Select("id", "ssn", "notes").
		From("customers").
		Where("ssn != '' OR notes != ''")
	rows, err := db.Query(sb.Build())
	if err != nil {
		return err
	}
	defer rows.Close()

	type record struct {
		ID    int64
		SSN   string
		Notes string
	}
	var records []record
	for rows.Next() {
		var r record
		if err := rows.Scan(&r.ID, &r.SSN, &r.Notes); err != nil {
			return err
		}
		records = append(records, r)
	}
	rows.Close()

	for _, r := range records {
		update := sqlite.Update("customers").Where("id = ?", r.ID)

		if r.SSN != "" {
			plain, err := oldKey.Decrypt(r.SSN)
			if err != nil {
				return fmt.Errorf("decrypt ssn for id %d: %w", r.ID, err)
			}
			enc, err := newKey.Encrypt(plain)
			if err != nil {
				return fmt.Errorf("re-encrypt ssn for id %d: %w", r.ID, err)
			}
			update = update.Set("ssn", enc)

			// Update the HMAC hash if using exact-match lookups.
			update = update.Set("ssn_hash", newKey.Hash(plain))
		}
		if r.Notes != "" {
			plain, err := oldKey.Decrypt(r.Notes)
			if err != nil {
				return fmt.Errorf("decrypt notes for id %d: %w", r.ID, err)
			}
			enc, err := newKey.Encrypt(plain)
			if err != nil {
				return fmt.Errorf("re-encrypt notes for id %d: %w", r.ID, err)
			}
			update = update.Set("notes", enc)
		}

		if _, err := db.Exec(update.Build()); err != nil {
			return fmt.Errorf("update id %d: %w", r.ID, err)
		}
	}
	return nil
}
```

After re-encryption completes, update `STANZA_ENCRYPTION_KEY` in your environment and restart the application.

{% callout title="Backup first" type="warning" %}
Always back up the database before key rotation. If the process is interrupted, some rows will be encrypted with the old key and others with the new key. The backup lets you start over cleanly.
{% /callout %}

---

## Tips

- **Encrypt selectively.** Only encrypt fields that genuinely need protection at rest — SSNs, tax IDs, bank accounts, medical records, private notes. Encrypting everything adds complexity without proportional security benefit.
- **Hash passwords, don't encrypt them.** Passwords should be one-way hashed with `auth.HashPassword`, not encrypted. You never need to recover a plaintext password.
- **Empty string means no data.** Always check for empty strings before decrypting. Rows created with `DEFAULT ''` should return empty, not a decryption error.
- **Each encrypt call produces unique output.** AES-GCM uses a random nonce, so encrypting `"123-45-6789"` twice produces different ciphertext. This is a security feature. Use HMAC hashes for exact-match lookups.
- **Skip sensitive fields in list responses.** List endpoints should omit encrypted columns from the SELECT entirely. Only decrypt on detail views where the user has been authorized.
- **The key is the single point of failure.** Lose the key and the encrypted data is unrecoverable. Store it in your deployment platform's secret management (Railway environment variables, Cloud Run secrets) and keep a secure offline backup.
- **Don't encrypt data you need to sort or aggregate.** SQL operations like `ORDER BY`, `GROUP BY`, `SUM`, and range queries (`WHERE amount > 100`) cannot work on encrypted columns. Only encrypt fields that are written and read back as-is.
