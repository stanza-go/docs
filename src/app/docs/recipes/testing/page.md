---
title: Testing
nextjs:
  metadata:
    title: Testing
    description: How to write and run tests for Stanza modules using real SQLite, httptest, and testutil.
---

Stanza tests hit a real SQLite database on every run. No mocks, no fakes, no in-memory substitutes. This recipe covers the test infrastructure, patterns, and commands you need to write reliable tests for your modules.

---

## Philosophy

- **Real database, always.** Every test gets a fresh SQLite file with all migrations applied and seed data inserted. This catches schema bugs, constraint violations, and query errors that mocks would hide.
- **No mocks for infrastructure.** The database, router, and auth system are all real. Only external services (email, third-party APIs) are stubbed via `httptest` servers.
- **Each test is isolated.** `testutil.SetupDB(t)` creates a temporary database in `t.TempDir()`. Tests never share state.
- **Parallel by default.** Mark tests with `t.Parallel()` unless they mutate shared process-level state (environment variables, global config).

---

## The testutil package

All test infrastructure lives in `api/testutil/testutil.go`. It provides:

| Function | Purpose |
|----------|---------|
| `SetupDB(t)` | Create a temp SQLite database with migrations + seed data |
| `NewRouter()` | Create a fresh HTTP router |
| `NewAdminAuth()` | Auth configured for admin routes (secure cookies off) |
| `NewUserAuth()` | Auth configured for user routes (cookie path `/api`) |
| `JSONRequest(t, method, path, body)` | Build an `*http.Request` with JSON body |
| `Do(router, req)` | Execute request against router, return `*httptest.ResponseRecorder` |
| `AddAdminAuth(t, req, auth, uid)` | Attach admin access token cookie to request |
| `AddUserAuth(t, req, auth, uid)` | Attach user access token cookie to request |
| `AddRefreshToken(req, token)` | Attach refresh token cookie to request |
| `DecodeJSON(t, rec, &v)` | Decode response body into a struct or map |
| `SetEnv(t, key, value)` | Set env var for test duration, restore on cleanup |
| `NewLogger(t)` | Logger that discards output |

### SetupDB in detail

```go
db := testutil.SetupDB(t)
```

This single call:

1. Creates a temporary directory via `t.TempDir()`
2. Opens a new SQLite database in that directory
3. Runs all migrations from `migration.Register(db)`
4. Inserts seed data (default admin, system roles, settings)
5. Registers `t.Cleanup()` to close the database when the test finishes

The returned `*sqlite.DB` is ready to use immediately. The temporary directory and database file are automatically deleted when the test completes.

---

## Test file structure

Every module has its test file alongside it:

```
api/module/products/
├── products.go        # module code
└── products_test.go   # tests
```

The test file uses the module's package name with `_test` suffix:

```go
package products_test

import (
    "testing"

    "github.com/stanza-go/framework/pkg/auth"
    fhttp "github.com/stanza-go/framework/pkg/http"
    "github.com/stanza-go/framework/pkg/sqlite"
    "github.com/stanza-go/standalone/module/products"
    "github.com/stanza-go/standalone/testutil"
)
```

{% callout title="External test packages" %}
Using `products_test` (not `products`) tests the module through its public API only. This catches accidentally unexported functions and ensures the module's interface is complete.
{% /callout %}

---

## Setup pattern

Every test file defines a `setup` function that creates the full dependency chain:

```go
func setup(t *testing.T) (*fhttp.Router, *auth.Auth, *sqlite.DB) {
    t.Helper()
    db := testutil.SetupDB(t)
    a := testutil.NewAdminAuth()
    router := testutil.NewRouter()
    api := router.Group("/api")
    admin := api.Group("/admin")
    admin.Use(a.RequireAuth())
    admin.Use(auth.RequireScope("admin"))
    products.Register(admin, db)
    return router, a, db
}
```

Key points:

- **`t.Helper()`** marks the function as a test helper so failures report the caller's line number, not the helper's.
- **Route groups mirror production wiring.** The test creates the same `/api/admin` group with the same middleware chain the real app uses.
- **Only register the module under test.** Don't wire up the entire application — test one module at a time.

For user-facing modules, use `NewUserAuth()` instead:

```go
func setup(t *testing.T) (*fhttp.Router, *auth.Auth, *sqlite.DB) {
    t.Helper()
    db := testutil.SetupDB(t)
    a := testutil.NewUserAuth()
    logger := testutil.NewLogger(t)
    router := testutil.NewRouter()
    api := router.Group("/api")
    userauth.Register(api, a, db, logger)
    return router, a, db
}
```

---

## Making requests

### Simple GET

```go
func TestListProducts(t *testing.T) {
    t.Parallel()
    router, a, _ := setup(t)

    req := httptest.NewRequest("GET", "/api/admin/products", nil)
    testutil.AddAdminAuth(t, req, a, "1")
    rec := testutil.Do(router, req)

    if rec.Code != 200 {
        t.Fatalf("status = %d, want 200\nbody: %s", rec.Code, rec.Body.String())
    }

    var resp map[string]any
    testutil.DecodeJSON(t, rec, &resp)

    products := resp["products"].([]any)
    total := int(resp["total"].(float64))
    if total < 0 {
        t.Errorf("total = %d, want >= 0", total)
    }
}
```

### POST with JSON body

```go
func TestCreateProduct(t *testing.T) {
    t.Parallel()
    router, a, _ := setup(t)

    req := testutil.JSONRequest(t, "POST", "/api/admin/products", map[string]any{
        "name":        "Widget",
        "price_cents": 999,
    })
    testutil.AddAdminAuth(t, req, a, "1")
    rec := testutil.Do(router, req)

    if rec.Code != 201 {
        t.Fatalf("status = %d, want 201\nbody: %s", rec.Code, rec.Body.String())
    }

    var resp map[string]any
    testutil.DecodeJSON(t, rec, &resp)
    product := resp["product"].(map[string]any)
    if product["name"] != "Widget" {
        t.Errorf("name = %v, want Widget", product["name"])
    }
}
```

### Testing error responses

```go
func TestCreateProduct_MissingFields(t *testing.T) {
    t.Parallel()
    router, a, _ := setup(t)

    req := testutil.JSONRequest(t, "POST", "/api/admin/products", map[string]any{})
    testutil.AddAdminAuth(t, req, a, "1")
    rec := testutil.Do(router, req)

    if rec.Code != 422 {
        t.Errorf("status = %d, want 422", rec.Code)
    }
}

func TestCreateProduct_Unauthorized(t *testing.T) {
    t.Parallel()
    router, _, _ := setup(t)

    req := testutil.JSONRequest(t, "POST", "/api/admin/products", map[string]any{
        "name": "Widget",
    })
    // No auth cookie added
    rec := testutil.Do(router, req)

    if rec.Code != 401 {
        t.Errorf("status = %d, want 401", rec.Code)
    }
}
```

---

## Multi-step tests

Some tests require creating a resource first, then operating on it. Chain the requests in a single test:

```go
func TestDeleteProduct(t *testing.T) {
    t.Parallel()
    router, a, _ := setup(t)

    // Step 1: Create a product.
    createReq := testutil.JSONRequest(t, "POST", "/api/admin/products", map[string]string{
        "name": "Doomed",
    })
    testutil.AddAdminAuth(t, createReq, a, "1")
    createRec := testutil.Do(router, createReq)
    if createRec.Code != 201 {
        t.Fatalf("create status = %d", createRec.Code)
    }

    var createResp map[string]any
    testutil.DecodeJSON(t, createRec, &createResp)
    product := createResp["product"].(map[string]any)
    id := int(product["id"].(float64))

    // Step 2: Delete it.
    deleteReq := httptest.NewRequest("DELETE", fmt.Sprintf("/api/admin/products/%d", id), nil)
    testutil.AddAdminAuth(t, deleteReq, a, "1")
    deleteRec := testutil.Do(router, deleteReq)

    if deleteRec.Code != 200 {
        t.Fatalf("delete status = %d\nbody: %s", deleteRec.Code, deleteRec.Body.String())
    }

    // Step 3: Verify it's gone from list.
    listReq := httptest.NewRequest("GET", "/api/admin/products", nil)
    testutil.AddAdminAuth(t, listReq, a, "1")
    listRec := testutil.Do(router, listReq)

    var listResp map[string]any
    testutil.DecodeJSON(t, listRec, &listResp)
    for _, p := range listResp["products"].([]any) {
        if p.(map[string]any)["name"] == "Doomed" {
            t.Error("deleted product still appears in list")
        }
    }
}
```

---

## Table-driven tests

Use table-driven tests to cover multiple cases without duplication:

```go
func TestCreateProduct_Validation(t *testing.T) {
    t.Parallel()
    router, a, _ := setup(t)

    tests := []struct {
        name string
        body map[string]any
        want int
    }{
        {"missing name", map[string]any{"price_cents": 100}, 422},
        {"negative price", map[string]any{"name": "X", "price_cents": -1}, 422},
        {"valid", map[string]any{"name": "X", "price_cents": 100}, 201},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()
            req := testutil.JSONRequest(t, "POST", "/api/admin/products", tt.body)
            testutil.AddAdminAuth(t, req, a, "1")
            rec := testutil.Do(router, req)
            if rec.Code != tt.want {
                t.Errorf("status = %d, want %d\nbody: %s", rec.Code, tt.want, rec.Body.String())
            }
        })
    }
}
```

{% callout title="Parallel subtests" %}
Call `t.Parallel()` inside each `t.Run()` subtest too. This allows subtests within the same table to run concurrently, speeding up the test suite.
{% /callout %}

---

## Testing auth flows

Auth tests involve cookies. Register or login first, extract cookies from the response, and attach them to subsequent requests:

```go
func TestLogin_ThenAccess(t *testing.T) {
    t.Parallel()
    router, _, _ := setup(t)

    // Register a user.
    regReq := testutil.JSONRequest(t, "POST", "/api/auth/register", map[string]string{
        "email":    "test@example.com",
        "password": "password123",
    })
    regRec := testutil.Do(router, regReq)
    if regRec.Code != 201 {
        t.Fatalf("register failed: %d", regRec.Code)
    }

    // Extract refresh token from response cookies.
    var refreshToken string
    for _, c := range regRec.Result().Cookies() {
        if c.Name == auth.RefreshTokenCookie {
            refreshToken = c.Value
        }
    }
    if refreshToken == "" {
        t.Fatal("no refresh token after register")
    }

    // Use refresh token to check status.
    statusReq := httptest.NewRequest("GET", "/api/auth/", nil)
    testutil.AddRefreshToken(statusReq, refreshToken)
    statusRec := testutil.Do(router, statusReq)

    if statusRec.Code != 200 {
        t.Fatalf("status = %d, want 200", statusRec.Code)
    }
}
```

For admin endpoints, skip the login flow — use the auth helper directly:

```go
req := httptest.NewRequest("GET", "/api/admin/products", nil)
testutil.AddAdminAuth(t, req, a, "1")  // admin ID "1" = seeded admin
```

---

## Framework package tests

Framework tests (`framework/pkg/...`) follow the same principles but don't use `testutil` — they test packages in isolation.

### Database test helper

```go
func openTestDB(t *testing.T) *sqlite.DB {
    t.Helper()
    db := sqlite.New(filepath.Join(t.TempDir(), "test.db"))
    if err := db.Start(context.Background()); err != nil {
        t.Fatalf("start: %v", err)
    }
    t.Cleanup(func() { db.Stop(context.Background()) })
    return db
}
```

### HTTP middleware tests

Use `httptest` to test middleware and handlers in isolation:

```go
func TestSecureHeaders(t *testing.T) {
    t.Parallel()
    router := NewRouter()
    router.Use(SecureHeaders(SecureHeadersConfig{}))
    router.HandleFunc("GET /test", func(w ResponseWriter, r *Request) {
        WriteJSON(w, 200, map[string]string{"ok": "true"})
    })

    req := httptest.NewRequest("GET", "/test", nil)
    rec := httptest.NewRecorder()
    router.ServeHTTP(rec, req)

    if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
        t.Error("missing X-Content-Type-Options header")
    }
}
```

### Validation tests (table-driven)

```go
func TestRequired(t *testing.T) {
    t.Parallel()
    tests := []struct {
        name    string
        value   string
        wantErr bool
    }{
        {"non-empty", "hello", false},
        {"empty", "", true},
        {"whitespace only", "   ", true},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()
            err := Required("field", tt.value)
            if (err != nil) != tt.wantErr {
                t.Errorf("Required(%q) error = %v, wantErr %v", tt.value, err, tt.wantErr)
            }
        })
    }
}
```

---

## Running tests

### Standalone (integration tests)

```bash
cd standalone/api && go test -race ./module/...
```

This runs all module tests (~235 tests) with the race detector enabled.

### Framework (unit tests)

```bash
cd framework && go test -race ./pkg/...
```

This runs all framework package tests (~489 tests).

### Useful flags

| Flag | Purpose |
|------|---------|
| `-race` | Enable the race detector. **Always use this.** |
| `-parallel N` | Set max parallel test count (default: `GOMAXPROCS`) |
| `-shuffle on` | Randomize test execution order to catch ordering dependencies |
| `-count N` | Run tests N times (useful for catching flaky tests) |
| `-run TestName` | Run only tests matching the pattern |
| `-v` | Verbose output — shows each test name and pass/fail |
| `-short` | Skip long-running tests (if they check `testing.Short()`) |

### Run a single module's tests

```bash
cd standalone/api && go test -race -v ./module/products/
```

### Detect flaky tests

```bash
cd standalone/api && go test -race -count=10 -shuffle=on ./module/...
```

---

## What to test

Every module should cover these cases at minimum:

| Category | Examples |
|----------|----------|
| **Happy path** | List returns data, create returns 201, update changes fields |
| **Authentication** | Request without token returns 401 |
| **Validation** | Missing required fields return 422 |
| **Not found** | Non-existent ID returns 404 |
| **Conflict** | Duplicate unique field returns 409 |
| **Business rules** | Self-deletion blocked, soft-deleted items excluded from lists |
| **Pagination** | `limit` and `offset` work correctly, `total` reflects all records |

---

## Tips

- **`t.Fatalf` vs `t.Errorf`.** Use `t.Fatalf` when the test can't continue (setup failure, missing response field). Use `t.Errorf` when you want to report the error but continue checking other assertions.
- **Include the body in failure messages.** When asserting status codes, log `rec.Body.String()` on failure — it contains the error message from the server.
- **JSON numbers are `float64`.** When decoding into `map[string]any`, all JSON numbers become `float64`. Cast with `int(resp["id"].(float64))`.
- **Pre-allocate empty slices.** Handlers return `[]` (empty array) not `null` because slices are initialized with `make([]T, 0)`. Tests can safely cast the response to `[]any`.
- **Don't sleep.** Use synchronization or direct assertions. If something isn't ready, the test infrastructure is wrong — fix the setup, not the timing.
- **One module per test file.** Each module's tests live in `module/{name}/{name}_test.go`. No shared test state between modules.
