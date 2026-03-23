---
title: API reference
nextjs:
  metadata:
    title: API reference
    description: Complete function signatures for all framework packages.
---

Complete function signatures for every exported type, function, and constant across all framework packages. Use this page to discover exact APIs without reading source code.

---

## pkg/http

```go
import "github.com/stanza-go/framework/pkg/http"
```

### Type aliases

```go
type Handler = net/http.Handler
type HandlerFunc = net/http.HandlerFunc
type ResponseWriter = net/http.ResponseWriter
type Request = net/http.Request
type Middleware func(Handler) Handler
```

### Router

```go
func NewRouter() *Router
func (r *Router) HandleFunc(pattern string, handler func(ResponseWriter, *Request))
func (r *Router) Handle(pattern string, handler Handler)
func (r *Router) Use(mw ...Middleware)
func (r *Router) Group(prefix string) *Group
func (r *Router) Routes() []Route
func (r *Router) ServeHTTP(w ResponseWriter, req *Request)
```

**Group** has the same registration methods:

```go
func (g *Group) HandleFunc(pattern string, handler func(ResponseWriter, *Request))
func (g *Group) Handle(pattern string, handler Handler)
func (g *Group) Use(mw ...Middleware)
func (g *Group) Group(prefix string) *Group
```

**Route** — returned by `Routes()`:

```go
type Route struct {
    Method string
    Path   string
}
```

### Server

```go
func NewServer(handler Handler, opts ...ServerOption) *Server
func (s *Server) Start(ctx context.Context) error
func (s *Server) Stop(ctx context.Context) error
func (s *Server) Addr() string

// Options
func WithAddr(addr string) ServerOption
func WithReadTimeout(d time.Duration) ServerOption
func WithWriteTimeout(d time.Duration) ServerOption
func WithIdleTimeout(d time.Duration) ServerOption
func WithMaxHeaderBytes(n int) ServerOption
```

### Response writing

```go
func WriteJSON(w ResponseWriter, status int, v any)
func WriteError(w ResponseWriter, status int, message string)
func WriteServerError(w ResponseWriter, r *Request, message string, err error)
func WriteCSV(w ResponseWriter, entity string, header []string, fn func() []string)
```

### Request parsing

```go
// Path parameters
func PathParam(r *Request, name string) string
func PathParamInt64(w ResponseWriter, r *Request, name string) (int64, bool)

// Query parameters
func QueryParam(r *Request, name string) string
func QueryParamOr(r *Request, name, fallback string) string
func QueryParamInt(r *Request, name string, fallback int) int
func QueryParamSort(r *Request, allowed []string, defaultCol, defaultDir string) (string, string)

// Request body
func ReadJSON(r *Request, v any) error
func ReadJSONLimit(r *Request, v any, maxBytes int64) error
func BindJSON(w ResponseWriter, r *Request, v any) bool
```

### Pagination

```go
type Pagination struct {
    Limit  int
    Offset int
}

func ParsePagination(r *Request, defaultLimit, maxLimit int) Pagination
func PaginatedResponse(w ResponseWriter, key string, items any, total int)
func CheckBulkIDs(w ResponseWriter, ids []int64, maxCount int) bool
```

### Middleware

```go
func Recovery(onPanic func(recovered any, stack []byte)) Middleware
func RequestLogger(logger *log.Logger) Middleware
func MaxBody(limit int64) Middleware
func SecureHeaders(cfg SecureHeadersConfig) Middleware
func CORS(cfg CORSConfig) Middleware
func RateLimit(cfg RateLimitConfig) Middleware
func RequestID(cfg RequestIDConfig) Middleware
func Compress(cfg CompressConfig) Middleware
func ETag(cfg ETagConfig) Middleware
```

**Config structs:**

```go
type SecureHeadersConfig struct {
    FrameOptions        string
    ReferrerPolicy      string
    PermissionsPolicy   string
    HSTSMaxAge          int
    ContentSecurityPolicy string
}

type CORSConfig struct {
    AllowOrigins     []string
    AllowMethods     []string
    AllowHeaders     []string
    AllowCredentials bool
    MaxAge           int
}

type RateLimitConfig struct {
    Limit   int
    Window  time.Duration
    KeyFunc func(*Request) string
    Message string
}

type RequestIDConfig struct {
    Header    string
    Generator func() string
}

type CompressConfig struct {
    Level        int
    MinSize      int
    ContentTypes []string
}

type ETagConfig struct {
    Weak bool
}
```

### Request utilities

```go
func ClientIP(r *Request) string
func GetRequestID(r *Request) string
```

### Static file serving

```go
func Static(fsys fs.FS) Handler
```

### Server-Sent Events

```go
func NewSSEWriter(w ResponseWriter) *SSEWriter
func (s *SSEWriter) Event(event, data string) error
func (s *SSEWriter) Data(data string) error
func (s *SSEWriter) Comment(text string) error
func (s *SSEWriter) Retry(ms int) error
```

### WebSocket

```go
type Upgrader struct {
    ReadBufferSize  int
    WriteBufferSize int
    CheckOrigin     func(r *Request) bool
}

func (u Upgrader) Upgrade(w ResponseWriter, r *Request) (*Conn, error)

func (c *Conn) ReadMessage() (MessageType, []byte, error)
func (c *Conn) WriteMessage(messageType MessageType, data []byte) error
func (c *Conn) WritePing(data []byte) error
func (c *Conn) WritePong(data []byte) error
func (c *Conn) Close() error
func (c *Conn) CloseWithMessage(code int, text string) error
func (c *Conn) SetMaxMessageSize(limit int64)
func (c *Conn) SetReadDeadline(t time.Time) error
func (c *Conn) SetWriteDeadline(t time.Time) error
func (c *Conn) SetPingHandler(h func(data []byte) error)
func (c *Conn) SetPongHandler(h func(data []byte) error)
func (c *Conn) RemoteAddr() net.Addr
func GenerateKey() string
```

**Message types:** `TextMessage = 1`, `BinaryMessage = 2`, `CloseMessage = 8`, `PingMessage = 9`, `PongMessage = 10`

**Close codes:** `CloseNormalClosure = 1000`, `CloseGoingAway = 1001`, `CloseProtocolError = 1002`, `CloseUnsupportedData = 1003`, `CloseNoStatusReceived = 1005`, `CloseAbnormalClosure = 1006`, `CloseInvalidPayload = 1007`, `ClosePolicyViolation = 1008`, `CloseMessageTooBig = 1009`

### Metrics

```go
func NewMetrics() *Metrics
func (m *Metrics) Middleware() Middleware
func (m *Metrics) Stats() MetricsStats

type MetricsStats struct {
    TotalRequests  int64
    ActiveRequests int64
    Status2xx      int64
    Status3xx      int64
    Status4xx      int64
    Status5xx      int64
    BytesWritten   int64
    AvgDurationMs  float64
}
```

### Prometheus

```go
func RuntimeMetrics() []PrometheusMetric
func PrometheusHandler(collect func() []PrometheusMetric) HandlerFunc

type PrometheusMetric struct {
    Name  string
    Help  string
    Type  string
    Value float64
}
```

### HTTP status constants

| Constant | Value |
|----------|-------|
| `StatusOK` | 200 |
| `StatusCreated` | 201 |
| `StatusNoContent` | 204 |
| `StatusMovedPermanently` | 301 |
| `StatusFound` | 302 |
| `StatusSeeOther` | 303 |
| `StatusNotModified` | 304 |
| `StatusTemporaryRedirect` | 307 |
| `StatusPermanentRedirect` | 308 |
| `StatusBadRequest` | 400 |
| `StatusUnauthorized` | 401 |
| `StatusForbidden` | 403 |
| `StatusNotFound` | 404 |
| `StatusMethodNotAllowed` | 405 |
| `StatusConflict` | 409 |
| `StatusGone` | 410 |
| `StatusRequestEntityTooLarge` | 413 |
| `StatusUnprocessableEntity` | 422 |
| `StatusTooManyRequests` | 429 |
| `StatusInternalServerError` | 500 |
| `StatusBadGateway` | 502 |
| `StatusServiceUnavailable` | 503 |

### Errors

```go
var ErrBodyTooLarge = errors.New("http: request body too large")
var ErrCloseSent = errors.New("websocket: close frame already sent")
var ErrReadLimit = errors.New("websocket: message exceeds read limit")
```

---

## pkg/sqlite

```go
import "github.com/stanza-go/framework/pkg/sqlite"
```

### Database

```go
func New(path string, opts ...Option) *DB
func (db *DB) Start(ctx context.Context) error
func (db *DB) Stop(ctx context.Context) error
func (db *DB) Path() string
func (db *DB) Stats() DBStats
func (db *DB) IntegrityCheck() error
func (db *DB) Optimize() error
func (db *DB) Backup(destPath string) error
func (db *DB) LastBackupPath() string

// Options
func WithBusyTimeout(ms int) Option
func WithReadPoolSize(n int) Option
func WithPragma(pragma string) Option
func WithLogger(l *log.Logger) Option
func WithSlowThreshold(d time.Duration) Option
```

**DBStats fields:** `ReadPoolSize int`, `ReadPoolAvailable int`, `ReadPoolInUse int`, `TotalReads int64`, `TotalWrites int64`, `PoolWaits int64`, `PoolWaitTime time.Duration`, `FileSize int64`, `WALSize int64`

### Queries

```go
func (db *DB) Exec(sql string, args ...any) (Result, error)
func (db *DB) Query(sql string, args ...any) (*Rows, error)
func (db *DB) QueryRow(sql string, args ...any) *Row
func (db *DB) Count(sb *SelectBuilder) (int, error)
func (db *DB) Insert(ib *InsertBuilder) (int64, error)
func (db *DB) Update(ub *UpdateBuilder) (int64, error)
func (db *DB) Delete(d *DeleteBuilder) (int64, error)
```

**Result fields:** `LastInsertID int64`, `RowsAffected int64`

### Generic query helpers

```go
func QueryOne[T any](db *DB, sql string, args []any, scan func(*Rows) (T, error)) (T, error)
func QueryAll[T any](db *DB, sql string, args []any, scan func(*Rows) (T, error)) ([]T, error)
```

### Rows and Row

```go
func (r *Rows) Next() bool
func (r *Rows) Scan(dest ...any) error
func (r *Rows) Columns() []string
func (r *Rows) Err() error
func (r *Rows) Close() error

func (r *Row) Scan(dest ...any) error
func (r *Row) Err() error
```

### Transactions

```go
func (db *DB) Begin() (*Tx, error)
func (db *DB) InTx(fn func(*Tx) error) error

func (tx *Tx) Commit() error
func (tx *Tx) Rollback() error
func (tx *Tx) Exec(sql string, args ...any) (Result, error)
func (tx *Tx) Query(sql string, args ...any) (*Rows, error)
func (tx *Tx) QueryRow(sql string, args ...any) *Row
func (tx *Tx) ExecMany(sql string, argSets [][]any) error
func (tx *Tx) Insert(ib *InsertBuilder) (int64, error)
func (tx *Tx) Update(ub *UpdateBuilder) (int64, error)
func (tx *Tx) Delete(d *DeleteBuilder) (int64, error)
```

### Migrations

```go
func (db *DB) AddMigration(version int64, name string, up, down func(tx *Tx) error)
func (db *DB) Migrate() (int, error)
func (db *DB) Rollback() (int64, error)
```

### SelectBuilder

```go
func Select(columns ...string) *SelectBuilder
func (b *SelectBuilder) From(table string) *SelectBuilder
func (b *SelectBuilder) Distinct() *SelectBuilder
func (b *SelectBuilder) Where(cond string, args ...any) *SelectBuilder
func (b *SelectBuilder) WhereNull(column string) *SelectBuilder
func (b *SelectBuilder) WhereNotNull(column string) *SelectBuilder
func (b *SelectBuilder) WhereIn(column string, values ...any) *SelectBuilder
func (b *SelectBuilder) WhereNotIn(column string, values ...any) *SelectBuilder
func (b *SelectBuilder) WhereOr(conds ...Condition) *SelectBuilder
func (b *SelectBuilder) WhereSearch(search string, columns ...string) *SelectBuilder
func (b *SelectBuilder) WhereInSelect(column string, sub *SelectBuilder) *SelectBuilder
func (b *SelectBuilder) WhereNotInSelect(column string, sub *SelectBuilder) *SelectBuilder
func (b *SelectBuilder) WhereExists(sub *SelectBuilder) *SelectBuilder
func (b *SelectBuilder) WhereNotExists(sub *SelectBuilder) *SelectBuilder
func (b *SelectBuilder) Join(table, on string) *SelectBuilder
func (b *SelectBuilder) LeftJoin(table, on string) *SelectBuilder
func (b *SelectBuilder) GroupBy(columns ...string) *SelectBuilder
func (b *SelectBuilder) Having(cond string, args ...any) *SelectBuilder
func (b *SelectBuilder) OrderBy(column, dir string) *SelectBuilder
func (b *SelectBuilder) Limit(n int) *SelectBuilder
func (b *SelectBuilder) Offset(n int) *SelectBuilder
func (b *SelectBuilder) Build() (string, []any)
```

### CountBuilder

```go
func Count(table string) *CountBuilder
func CountFrom(sb *SelectBuilder) *CountBuilder
func (b *CountBuilder) Where(cond string, args ...any) *CountBuilder
func (b *CountBuilder) WhereNull(column string) *CountBuilder
func (b *CountBuilder) WhereNotNull(column string) *CountBuilder
func (b *CountBuilder) WhereIn(column string, values ...any) *CountBuilder
func (b *CountBuilder) WhereNotIn(column string, values ...any) *CountBuilder
func (b *CountBuilder) WhereOr(conds ...Condition) *CountBuilder
func (b *CountBuilder) WhereSearch(search string, columns ...string) *CountBuilder
func (b *CountBuilder) WhereInSelect(column string, sub *SelectBuilder) *CountBuilder
func (b *CountBuilder) WhereNotInSelect(column string, sub *SelectBuilder) *CountBuilder
func (b *CountBuilder) WhereExists(sub *SelectBuilder) *CountBuilder
func (b *CountBuilder) WhereNotExists(sub *SelectBuilder) *CountBuilder
func (b *CountBuilder) Build() (string, []any)
```

### InsertBuilder

```go
func Insert(table string) *InsertBuilder
func (b *InsertBuilder) Set(column string, value any) *InsertBuilder
func (b *InsertBuilder) OrIgnore() *InsertBuilder
func (b *InsertBuilder) OnConflict(conflictColumns, updateColumns []string) *InsertBuilder
func (b *InsertBuilder) Build() (string, []any)
```

### InsertBatchBuilder

```go
func InsertBatch(table string) *InsertBatchBuilder
func (b *InsertBatchBuilder) Columns(columns ...string) *InsertBatchBuilder
func (b *InsertBatchBuilder) Row(values ...any) *InsertBatchBuilder
func (b *InsertBatchBuilder) OrIgnore() *InsertBatchBuilder
func (b *InsertBatchBuilder) OnConflict(conflictColumns, updateColumns []string) *InsertBatchBuilder
func (b *InsertBatchBuilder) Build() (string, []any)
```

### UpdateBuilder

```go
func Update(table string) *UpdateBuilder
func (b *UpdateBuilder) Set(column string, value any) *UpdateBuilder
func (b *UpdateBuilder) SetExpr(column, expr string, args ...any) *UpdateBuilder
func (b *UpdateBuilder) Where(cond string, args ...any) *UpdateBuilder
func (b *UpdateBuilder) WhereNull(column string) *UpdateBuilder
func (b *UpdateBuilder) WhereNotNull(column string) *UpdateBuilder
func (b *UpdateBuilder) WhereIn(column string, values ...any) *UpdateBuilder
func (b *UpdateBuilder) WhereNotIn(column string, values ...any) *UpdateBuilder
func (b *UpdateBuilder) WhereOr(conds ...Condition) *UpdateBuilder
func (b *UpdateBuilder) WhereSearch(search string, columns ...string) *UpdateBuilder
func (b *UpdateBuilder) WhereInSelect(column string, sub *SelectBuilder) *UpdateBuilder
func (b *UpdateBuilder) WhereNotInSelect(column string, sub *SelectBuilder) *UpdateBuilder
func (b *UpdateBuilder) WhereExists(sub *SelectBuilder) *UpdateBuilder
func (b *UpdateBuilder) WhereNotExists(sub *SelectBuilder) *UpdateBuilder
func (b *UpdateBuilder) Build() (string, []any)
```

### DeleteBuilder

```go
func Delete(table string) *DeleteBuilder
func (b *DeleteBuilder) Where(cond string, args ...any) *DeleteBuilder
func (b *DeleteBuilder) WhereNull(column string) *DeleteBuilder
func (b *DeleteBuilder) WhereNotNull(column string) *DeleteBuilder
func (b *DeleteBuilder) WhereIn(column string, values ...any) *DeleteBuilder
func (b *DeleteBuilder) WhereNotIn(column string, values ...any) *DeleteBuilder
func (b *DeleteBuilder) WhereOr(conds ...Condition) *DeleteBuilder
func (b *DeleteBuilder) WhereSearch(search string, columns ...string) *DeleteBuilder
func (b *DeleteBuilder) WhereInSelect(column string, sub *SelectBuilder) *DeleteBuilder
func (b *DeleteBuilder) WhereNotInSelect(column string, sub *SelectBuilder) *DeleteBuilder
func (b *DeleteBuilder) WhereExists(sub *SelectBuilder) *DeleteBuilder
func (b *DeleteBuilder) WhereNotExists(sub *SelectBuilder) *DeleteBuilder
func (b *DeleteBuilder) Build() (string, []any)
```

### Condition (for WhereOr)

```go
func Cond(cond string, args ...any) Condition
```

### SQL helpers

```go
func EscapeLike(s string) string
func Sum(column string) string
func Avg(column string) string
func Min(column string) string
func Max(column string) string
func As(expr, alias string) string
func Coalesce(column, fallback string) string
func CoalesceEmpty(column string) string
func FormatTime(t time.Time) string
func Now() string
func FormatID(id int64) string
```

### Error handling

```go
var ErrNoRows = errors.New("sqlite: no rows")

func IsConstraintError(err error) bool
func IsUniqueConstraintError(err error) bool
func IsForeignKeyConstraintError(err error) bool
func IsNotNullConstraintError(err error) bool
```

**Error codes:** `CodeConstraint = 19`, `CodeConstraintCheck = 275`, `CodeConstraintForeignKey = 787`, `CodeConstraintNotNull = 1299`, `CodeConstraintPrimaryKey = 1555`, `CodeConstraintUnique = 2067`

---

## pkg/auth

```go
import "github.com/stanza-go/framework/pkg/auth"
```

### Auth

```go
func New(signingKey []byte, opts ...Option) *Auth
func (a *Auth) IssueAccessToken(uid string, scopes []string) (string, error)
func (a *Auth) ValidateAccessToken(token string) (Claims, error)
func (a *Auth) AccessTokenTTL() time.Duration
func (a *Auth) RefreshTokenTTL() time.Duration
func (a *Auth) Stats() AuthStats

// Options
func WithAccessTokenTTL(d time.Duration) Option
func WithRefreshTokenTTL(d time.Duration) Option
func WithCookiePath(path string) Option
func WithSecureCookies(secure bool) Option
```

**AuthStats fields:** `Issued int64`, `Accepted int64`, `Rejected int64`

### Cookies

```go
func (a *Auth) SetAccessTokenCookie(w http.ResponseWriter, token string)
func (a *Auth) SetRefreshTokenCookie(w http.ResponseWriter, token string)
func (a *Auth) ClearAccessTokenCookie(w http.ResponseWriter)
func (a *Auth) ClearRefreshTokenCookie(w http.ResponseWriter)
func (a *Auth) ClearAllCookies(w http.ResponseWriter)
func ReadAccessToken(r *http.Request) (string, error)
func ReadRefreshToken(r *http.Request) (string, error)
```

**Cookie names:** `AccessTokenCookie = "access_token"`, `RefreshTokenCookie = "refresh_token"`

### Claims

```go
type Claims struct {
    UID       string
    Scopes    []string
    IssuedAt  int64
    ExpiresAt int64
}

func (c Claims) Valid() bool
func (c Claims) IntUID() int64
func (c Claims) HasScope(scope string) bool
```

### Middleware

```go
func (a *Auth) RequireAuth() func(http.Handler) http.Handler
func (a *Auth) RequireAuthOrAPIKey(validator KeyValidator) func(http.Handler) http.Handler
func RequireAPIKey(validator KeyValidator) func(http.Handler) http.Handler
func RequireScope(scope string) func(http.Handler) http.Handler
```

**KeyValidator type:** `func(keyHash string) (Claims, error)`

### Context

```go
func ClaimsFromContext(ctx context.Context) (Claims, bool)
func WithClaimsForTest(ctx context.Context, claims Claims) context.Context
```

### Token utilities

```go
func CreateJWT(key []byte, claims Claims) (string, error)
func ValidateJWT(key []byte, token string) (Claims, error)
func GenerateRefreshToken() (string, error)
func HashToken(token string) string
func GenerateID() (string, error)
func GenerateAPIKey(prefix string) (fullKey, displayPrefix, keyHash string, err error)
```

### Password

```go
func HashPassword(password string) (string, error)
func VerifyPassword(hash, password string) bool
```

### Errors

```go
var ErrInvalidToken
var ErrTokenExpired
var ErrNoToken
```

---

## pkg/validate

```go
import "github.com/stanza-go/framework/pkg/validate"
```

### Validator

```go
func Fields(checks ...*FieldError) *Validator
func (v *Validator) HasErrors() bool
func (v *Validator) Errors() map[string]string
func (v *Validator) Add(checks ...*FieldError)
func (v *Validator) WriteError(w http.ResponseWriter)

type FieldError struct {
    Field   string
    Message string
}
```

### Check functions

All return `*FieldError` — `nil` on success, error on failure. All skip empty strings except `Required`.

```go
func Required(field, value string) *FieldError
func MinLen(field, value string, min int) *FieldError
func MaxLen(field, value string, max int) *FieldError
func Email(field, value string) *FieldError
func URL(field, value string) *FieldError
func PublicURL(field, value string) *FieldError
func OneOf(field, value string, allowed ...string) *FieldError
func Positive(field string, value int) *FieldError
func InRange(field string, value, min, max int) *FieldError
func FutureDate(field, value string) *FieldError
func Slug(field, value string) *FieldError
func Check(field string, ok bool, message string) *FieldError
```

---

## pkg/queue

```go
import "github.com/stanza-go/framework/pkg/queue"
```

### Queue

```go
func New(db *sqlite.DB, opts ...Option) *Queue
func (q *Queue) Register(jobType string, handler HandlerFunc)
func (q *Queue) Enqueue(_ context.Context, jobType string, payload []byte, opts ...EnqueueOption) (int64, error)
func (q *Queue) Start(_ context.Context) error
func (q *Queue) Stop(ctx context.Context) error
func (q *Queue) Stats() (Stats, error)
func (q *Queue) Job(id int64) (Job, error)
func (q *Queue) JobCount(f Filter) (int, error)
func (q *Queue) Jobs(f Filter) ([]Job, error)
func (q *Queue) Retry(id int64) error
func (q *Queue) Cancel(id int64) error
func (q *Queue) Purge(olderThan time.Duration) (int64, error)

type HandlerFunc func(ctx context.Context, payload []byte) error
```

### Queue options

```go
func WithWorkers(n int) Option
func WithPollInterval(d time.Duration) Option
func WithLogger(l *log.Logger) Option
func WithMaxAttempts(n int) Option
func WithRetryDelay(d time.Duration) Option
func WithDefaultTimeout(d time.Duration) Option
```

### Enqueue options

```go
func Delay(d time.Duration) EnqueueOption
func MaxAttempts(n int) EnqueueOption
func Timeout(d time.Duration) EnqueueOption
func OnQueue(name string) EnqueueOption
```

### Job

```go
type Job struct {
    ID          int64
    Queue       string
    Type        string
    Payload     []byte
    Status      string
    Attempts    int
    MaxAttempts int
    Timeout     time.Duration
    LastError   string
    RunAt       time.Time
    StartedAt   time.Time
    CompletedAt time.Time
    CreatedAt   time.Time
    UpdatedAt   time.Time
}
```

### Filter and Stats

```go
type Filter struct {
    Queue  string
    Type   string
    Status string
    Limit  int
    Offset int
}

type Stats struct {
    Pending   int
    Running   int
    Completed int
    Failed    int
    Dead      int
    Cancelled int
}
```

### Status constants

`StatusPending = "pending"`, `StatusRunning = "running"`, `StatusCompleted = "completed"`, `StatusFailed = "failed"`, `StatusDead = "dead"`, `StatusCancelled = "cancelled"`

---

## pkg/cron

```go
import "github.com/stanza-go/framework/pkg/cron"
```

### Scheduler

```go
func NewScheduler(opts ...Option) *Scheduler
func (s *Scheduler) Add(name, expr string, fn Func, opts ...JobOption) error
func (s *Scheduler) Start(ctx context.Context) error
func (s *Scheduler) Stop(ctx context.Context) error
func (s *Scheduler) Entries() []Entry
func (s *Scheduler) Stats() SchedulerStats
func (s *Scheduler) Enable(name string) error
func (s *Scheduler) Disable(name string) error
func (s *Scheduler) Trigger(name string) error

type Func func(ctx context.Context) error
```

### Options

```go
func WithLocation(loc *time.Location) Option
func WithLogger(l *log.Logger) Option
func WithOnComplete(fn func(CompletedRun)) Option
func WithDefaultTimeout(d time.Duration) Option
func Timeout(d time.Duration) JobOption
```

### Entry and Stats

```go
type Entry struct {
    Name     string
    Schedule string
    Enabled  bool
    Running  bool
    LastRun  time.Time
    NextRun  time.Time
    LastErr  error
    Timeout  time.Duration
}

type CompletedRun struct {
    Name     string
    Started  time.Time
    Duration time.Duration
    Err      error
}

type SchedulerStats struct {
    Jobs      int
    Completed int64
    Failed    int64
    Skipped   int64
}
```

---

## pkg/task

```go
import "github.com/stanza-go/framework/pkg/task"
```

### Pool

```go
func New(opts ...Option) *Pool
func (p *Pool) Start(_ context.Context) error
func (p *Pool) Stop(_ context.Context) error
func (p *Pool) Submit(fn func()) bool
func (p *Pool) Stats() Stats

// Options
func WithWorkers(n int) Option
func WithBuffer(n int) Option
func WithLogger(l *log.Logger) Option
```

### Stats

```go
type Stats struct {
    Workers   int
    Buffer    int
    Pending   int
    Submitted int64
    Completed int64
    Panics    int64
    Dropped   int64
}
```

---

## pkg/log

```go
import "github.com/stanza-go/framework/pkg/log"
```

### Logger

```go
func New(opts ...Option) *Logger
func (l *Logger) Debug(msg string, fields ...Field)
func (l *Logger) Info(msg string, fields ...Field)
func (l *Logger) Warn(msg string, fields ...Field)
func (l *Logger) Error(msg string, fields ...Field)
func (l *Logger) With(fields ...Field) *Logger

// Options
func WithLevel(level Level) Option
func WithWriter(w io.Writer) Option
func WithFields(fields ...Field) Option
```

### Levels

```go
func ParseLevel(s string) Level

const LevelDebug Level = iota
const LevelInfo
const LevelWarn
const LevelError
```

### Fields

```go
func String(key, val string) Field
func Int(key string, val int) Field
func Int64(key string, val int64) Field
func Float64(key string, val float64) Field
func Bool(key string, val bool) Field
func Err(err error) Field
func Duration(key string, val time.Duration) Field
func Time(key string, val time.Time) Field
func Any(key string, val any) Field
```

### File writer

```go
func NewFileWriter(dir string, opts ...FileOption) (*FileWriter, error)
func (fw *FileWriter) Write(p []byte) (int, error)
func (fw *FileWriter) Close() error

// Options
func WithMaxSize(bytes int64) FileOption
func WithMaxFiles(n int) FileOption
```

### Context

```go
func NewContext(ctx context.Context, l *Logger) context.Context
func FromContext(ctx context.Context) *Logger
```

---

## pkg/config

```go
import "github.com/stanza-go/framework/pkg/config"
```

### Config

```go
func New(opts ...Option) *Config
func Load(path string, opts ...Option) (*Config, error)
func (c *Config) Validate() error
func (c *Config) GetString(key string) string
func (c *Config) GetStringOr(key, fallback string) string
func (c *Config) GetInt(key string) int
func (c *Config) GetInt64(key string) int64
func (c *Config) GetFloat64(key string) float64
func (c *Config) GetBool(key string) bool
func (c *Config) GetDuration(key string) time.Duration
func (c *Config) Has(key string) bool

// Options
func WithDefaults(defaults map[string]string) Option
func WithEnvPrefix(prefix string) Option
func WithRequired(keys ...string) Option
```

---

## pkg/lifecycle

```go
import "github.com/stanza-go/framework/pkg/lifecycle"
```

### App

```go
func New(opts ...Option) *App
func (a *App) Start(ctx context.Context) error
func (a *App) Stop(ctx context.Context) error
func (a *App) Run() error
func (a *App) Err() error
func (a *App) Shutdown()

// Options
func Provide(constructors ...any) Option
func Invoke(funcs ...any) Option
func WithStartTimeout(d time.Duration) Option
func WithStopTimeout(d time.Duration) Option
```

### Lifecycle hooks

```go
type Hook struct {
    OnStart func(context.Context) error
    OnStop  func(context.Context) error
}

func (l *Lifecycle) Append(h Hook)
```

---

## pkg/cmd

```go
import "github.com/stanza-go/framework/pkg/cmd"
```

### App

```go
func New(name string, opts ...Option) *App
func (a *App) Command(name, desc string, run func(*Context) error, opts ...CommandOption) *Command
func (a *App) Run(args []string) error

// Options
func WithVersion(v string) Option
func WithDescription(d string) Option
func WithOutput(w io.Writer) Option
func WithDefaultCommand(name string) Option
```

### Command

```go
func (c *Command) Command(name, desc string, run func(*Context) error, opts ...CommandOption) *Command

// Flag options (passed as CommandOption)
func StringFlag(name, def, desc string) CommandOption
func IntFlag(name string, def int, desc string) CommandOption
func BoolFlag(name string, def bool, desc string) CommandOption
func DurationFlag(name string, def time.Duration, desc string) CommandOption
```

### Context

```go
func (c *Context) String(name string) string
func (c *Context) Int(name string) int
func (c *Context) Bool(name string) bool
func (c *Context) Duration(name string) time.Duration
func (c *Context) Has(name string) bool
func (c *Context) Args() []string
func (c *Context) Arg(i int) string
```

---

## pkg/email

```go
import "github.com/stanza-go/framework/pkg/email"
```

### Client

```go
func New(apiKey string, opts ...Option) *Client
func (c *Client) Send(ctx context.Context, msg Message) (SendResult, error)
func (c *Client) Configured() bool
func (c *Client) Stats() EmailStats

// Options
func WithFrom(from string) Option
func WithEndpoint(endpoint string) Option
func WithTimeout(d time.Duration) Option
```

### Message

```go
type Message struct {
    To      []string
    Subject string
    HTML    string
    Text    string
    From    string
    ReplyTo []string
}

type SendResult struct {
    ID string
}

type EmailStats struct {
    Sent   int64
    Errors int64
}
```

### Errors

```go
var ErrNoRecipient = errors.New("email: at least one recipient is required")
var ErrNoSubject = errors.New("email: subject is required")
var ErrNoBody = errors.New("email: at least one of HTML or Text body is required")
var ErrNoFrom = errors.New("email: sender address is required (set via WithFrom or Message.From)")
var ErrNoAPIKey = errors.New("email: API key is required")

type APIError struct {
    StatusCode int
    Body       string
}
func (e *APIError) Error() string
```

---

## pkg/cache

```go
import "github.com/stanza-go/framework/pkg/cache"
```

### Cache

```go
func New[V any](opts ...Option[V]) *Cache[V]
func (c *Cache[V]) Get(key string) (V, bool)
func (c *Cache[V]) Set(key string, value V)
func (c *Cache[V]) SetWithTTL(key string, value V, ttl time.Duration)
func (c *Cache[V]) GetOrSet(key string, fn func() (V, error)) (V, error)
func (c *Cache[V]) GetOrSetWithTTL(key string, ttl time.Duration, fn func() (V, error)) (V, error)
func (c *Cache[V]) Delete(key string)
func (c *Cache[V]) Clear()
func (c *Cache[V]) Len() int
func (c *Cache[V]) Keys() []string
func (c *Cache[V]) Stats() CacheStats
func (c *Cache[V]) Close()

// Options
func WithTTL[V any](d time.Duration) Option[V]
func WithMaxSize[V any](n int) Option[V]
func WithCleanupInterval[V any](d time.Duration) Option[V]
func WithOnEvict[V any](fn func(key string, value V)) Option[V]
```

### CacheStats

```go
type CacheStats struct {
    Size      int
    MaxSize   int
    Hits      int64
    Misses    int64
    Evictions int64
}
```

---

## pkg/webhook

```go
import "github.com/stanza-go/framework/pkg/webhook"
```

### Client

```go
func NewClient(opts ...Option) *Client
func (c *Client) Send(ctx context.Context, d *Delivery) (*Result, error)
func (c *Client) SendWithRetry(ctx context.Context, d *Delivery) (*Result, error)
func (c *Client) Stats() ClientStats

// Options
func WithTimeout(d time.Duration) Option
func WithMaxRetries(n int) Option
func WithRetryBaseDelay(d time.Duration) Option
func WithRetryMaxDelay(d time.Duration) Option
```

### Delivery and Result

```go
type Delivery struct {
    URL     string
    Secret  string
    Event   string
    Payload []byte
    Headers map[string]string
}

type Result struct {
    StatusCode int
    Body       string
    Attempts   int
    DeliveryID string
}

type ClientStats struct {
    Sends     int64
    Successes int64
    Failures  int64
    Retries   int64
    Errors    int64
}
```

### Signing

```go
func Sign(secret, id, timestamp string, body []byte) string
func Verify(secret, id, timestamp, signature string, body []byte) bool
```

### Header constants

`HeaderID = "X-Webhook-ID"`, `HeaderTimestamp = "X-Webhook-Timestamp"`, `HeaderSignature = "X-Webhook-Signature"`, `HeaderEvent = "X-Webhook-Event"`

### Errors

```go
var ErrNoURL = fmt.Errorf("webhook: URL is required")
```
