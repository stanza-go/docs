---
title: Admin dashboard patterns
nextjs:
  metadata:
    title: Admin dashboard patterns
    description: Building custom dashboard sections with stat cards, time-series charts, activity feeds, and caching strategies.
---

The admin dashboard is the first thing you see after login. This recipe shows how to extend it with custom stat cards, time-series charts, activity feeds, and domain-specific metrics — all following the patterns already established in the standalone app.

The dashboard has two layers: a **Go API endpoint** that aggregates and caches data, and a **React frontend** that renders it. This recipe covers both.

---

## Dashboard API architecture

The dashboard endpoint returns all stats in a single JSON response. The key architectural decision: **cheap data is fetched live, expensive data is cached.**

```go
func Register(admin *http.Group, db *sqlite.DB, q *queue.Queue,
    s *cron.Scheduler, m *http.Metrics) {

    // Cache expensive DB queries — 30s TTL, single entry.
    statsCache := cache.New[*dbStats](
        cache.WithTTL[*dbStats](30 * time.Second),
        cache.WithMaxSize[*dbStats](1),
    )
    // Cache chart data — 5 min TTL, one entry per period.
    chartsCache := cache.New[*chartsData](
        cache.WithTTL[*chartsData](5 * time.Minute),
        cache.WithMaxSize[*chartsData](3),
    )

    admin.HandleFunc("GET /dashboard", statsHandler(db, q, s, m, statsCache))
    admin.HandleFunc("GET /dashboard/charts", chartsHandler(db, chartsCache))
}
```

Two endpoints, not one. The main stats endpoint is polled every 30 seconds and must be fast. The charts endpoint returns heavier time-series data that changes slowly — cached for 5 minutes.

### Cheap vs expensive data

| Source | Cost | Strategy |
|--------|------|----------|
| `db.Stats()`, `m.Stats()`, `s.Stats()` | Free — atomic reads | Fetch live on every request |
| `q.Stats()` | Single indexed query | Fetch live (fast enough) |
| Table counts (`COUNT(*)` on users, orders) | Multiple DB queries | Cache with 30s TTL |
| Time-series aggregations (charts) | Complex GROUP BY queries | Cache with 5 min TTL |
| `runtime.ReadMemStats()` | Stop-the-world pause | Fetch live but don't call in loops |

The rule: **if it's an atomic counter, call it live. If it hits the database, cache it.**

---

## Adding a custom stat section

When you add a new module (e.g., "Orders"), you'll want its stats on the dashboard. The pattern has three steps: define the data, query it, and include it in the response.

### 1. Extend the cached stats struct

Add your fields to the `dbStats` struct that holds cached database counts:

```go
type dbStats struct {
    // Existing fields...
    TotalUsers     int `json:"total_users"`
    ActiveSessions int `json:"active_sessions"`

    // Your new fields.
    TotalOrders    int `json:"total_orders"`
    PendingOrders  int `json:"pending_orders"`
    TodayRevenue   int `json:"today_revenue"` // cents
}
```

### 2. Query in the cache function

Add your queries to `queryDBStats`. Use the query builder — each count is a single indexed query:

```go
func queryDBStats(db *sqlite.DB) (*dbStats, error) {
    st := &dbStats{}

    // Existing queries...
    sql, args := sqlite.Count("users").WhereNull("deleted_at").Build()
    _ = db.QueryRow(sql, args...).Scan(&st.TotalUsers)

    // Your new queries.
    sql, args = sqlite.Count("orders").Build()
    _ = db.QueryRow(sql, args...).Scan(&st.TotalOrders)

    sql, args = sqlite.Count("orders").Where("status = ?", "pending").Build()
    _ = db.QueryRow(sql, args...).Scan(&st.PendingOrders)

    today := time.Now().UTC().Format("2006-01-02")
    sql, args = sqlite.Select("COALESCE(SUM(total_cents), 0)").
        From("orders").
        Where("status = ?", "completed").
        Where("date(created_at) = ?", today).
        Build()
    _ = db.QueryRow(sql, args...).Scan(&st.TodayRevenue)

    return st, nil
}
```

### 3. Include in the response

Add your section to the JSON response in the stats handler:

```go
http.WriteJSON(w, http.StatusOK, map[string]any{
    "system":   systemStats,
    "database": dbStats,
    "queue":    queueStats,
    // Your new section.
    "orders": map[string]any{
        "total":         st.TotalOrders,
        "pending":       st.PendingOrders,
        "today_revenue": st.TodayRevenue,
    },
})
```

{% callout title="Keep the stats handler fast" %}
Everything in `queryDBStats` runs inside a cache miss — at most once every 30 seconds. Don't optimize individual queries here. But do keep the total count of queries reasonable. If you have more than ~10 count queries, consider combining related ones into a single query with `CASE` expressions.
{% /callout %}

---

## Time-series charts

Dashboard charts show trends over time — new users per day, revenue per day, failed jobs per day. The pattern: **query date-bucketed data, then gap-fill missing dates** so the chart has no holes.

### The gap-filling pattern

SQLite `GROUP BY date(created_at)` only returns rows for dates that have data. If nobody signed up on Tuesday, Tuesday is missing from the result. The frontend chart needs every date in the range — otherwise the x-axis has gaps.

Solution: generate all dates in Go, query the DB, merge:

```go
func queryOrderChart(db *sqlite.DB, days int) ([]dayCount, error) {
    since := time.Now().UTC().AddDate(0, 0, -days).Format("2006-01-02")

    // Step 1: Generate all dates in range.
    dates := make([]string, 0, days+1)
    for i := days; i >= 0; i-- {
        dates = append(dates, time.Now().UTC().AddDate(0, 0, -i).Format("2006-01-02"))
    }

    // Step 2: Query actual counts from DB.
    counts := make(map[string]int, days+1)
    sql, args := sqlite.Select("date(created_at) as day", "COUNT(*) as cnt").
        From("orders").
        Where("created_at >= ?", since).
        GroupBy("day").
        OrderBy("day", "ASC").
        Build()
    rows, err := db.Query(sql, args...)
    if err != nil {
        return nil, err
    }
    for rows.Next() {
        var day string
        var cnt int
        if err := rows.Scan(&day, &cnt); err != nil {
            break
        }
        counts[day] = cnt
    }
    _ = rows.Err()
    rows.Close()

    // Step 3: Merge — missing dates get count 0.
    result := make([]dayCount, 0, len(dates))
    for _, d := range dates {
        result = append(result, dayCount{Date: d, Count: counts[d]})
    }
    return result, nil
}

type dayCount struct {
    Date  string `json:"date"`
    Count int    `json:"count"`
}
```

### Multi-series charts

For charts with multiple series (e.g., completed vs failed jobs), use `CASE` expressions in the query and a struct with multiple fields:

```go
type dayJobCount struct {
    Date      string `json:"date"`
    Completed int    `json:"completed"`
    Failed    int    `json:"failed"`
}

sql, args := sqlite.Select(
    "date(created_at) as day",
    "SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed",
    "SUM(CASE WHEN status IN ('failed','dead') THEN 1 ELSE 0 END) as failed",
).
    From("_queue_jobs").
    Where("created_at >= ?", since).
    GroupBy("day").
    OrderBy("day", "ASC").
    Build()
```

### Period selector

Support multiple time ranges (7d, 30d, 90d) via a query parameter. Cache each period separately:

```go
func chartsHandler(db *sqlite.DB, chartsCache *cache.Cache[*chartsData]) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        period := r.URL.Query().Get("period")
        days := 7
        switch period {
        case "30d":
            days = 30
        case "90d":
            days = 90
        default:
            period = "7d"
        }

        data, _ := chartsCache.GetOrSet(period, func() (*chartsData, error) {
            return queryCharts(db, days)
        })
        if data == nil {
            data = &chartsData{}
        }

        http.WriteJSON(w, http.StatusOK, data)
    }
}
```

The cache holds up to 3 entries (one per period). Each period is cached independently for 5 minutes.

{% callout title="Chart queries and indexes" %}
The `date(created_at)` grouping can't use an index directly — SQLite evaluates the function on each row. For tables with millions of rows, consider adding a `created_date TEXT` column that stores `YYYY-MM-DD` and index it. For typical Stanza apps (thousands of rows), the function approach is fast enough.
{% /callout %}

---

## Activity feed

The dashboard's activity feed shows recent admin actions — a timeline of who did what. This uses the audit log table, joining with the admins table to show names.

### API endpoint

A simple "last N entries" query — no pagination, no filtering. This endpoint is separate from the full audit log list:

```go
admin.HandleFunc("GET /audit/recent", recentHandler(db))

func recentHandler(db *sqlite.DB) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        sql, args := sqlite.Select(
            "audit_log.id", "audit_log.admin_id",
            sqlite.CoalesceEmpty("admins.email"), sqlite.CoalesceEmpty("admins.name"),
            "audit_log.action", "audit_log.entity_type", "audit_log.entity_id",
            "audit_log.details", "audit_log.ip_address", "audit_log.created_at",
        ).From("audit_log").
            LeftJoin("admins", "admins.id = CAST(audit_log.admin_id AS INTEGER)").
            OrderBy("audit_log.id", "DESC").
            Limit(10).
            Build()

        rows, err := db.Query(sql, args...)
        if err != nil {
            http.WriteServerError(w, r, "failed to list recent activity", err)
            return
        }
        defer rows.Close()

        entries := make([]entryJSON, 0)
        for rows.Next() {
            var e entryJSON
            if err := rows.Scan(&e.ID, &e.AdminID, &e.AdminEmail, &e.AdminName,
                &e.Action, &e.EntityType, &e.EntityID,
                &e.Details, &e.IPAddress, &e.CreatedAt); err != nil {
                http.WriteServerError(w, r, "failed to scan audit entry", err)
                return
            }
            entries = append(entries, e)
        }
        if err := rows.Err(); err != nil {
            http.WriteServerError(w, r, "failed to iterate entries", err)
            return
        }

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "entries": entries,
        })
    }
}
```

### Custom activity feeds

For domain-specific activity (e.g., "recent orders"), follow the same pattern with your own table:

```go
admin.HandleFunc("GET /orders/recent", func(w http.ResponseWriter, r *http.Request) {
    sql, args := sqlite.Select(
        "orders.id", "orders.status",
        sqlite.Coalesce("users.name", "users.email"), "orders.total_cents",
        "orders.created_at",
    ).From("orders").
        LeftJoin("users", "users.id = orders.user_id").
        OrderBy("orders.id", "DESC").
        Limit(5).
        Build()

    rows, err := db.Query(sql, args...)
    if err != nil {
        http.WriteServerError(w, r, "failed to list recent orders", err)
        return
    }
    defer rows.Close()

    var orders []map[string]any
    for rows.Next() {
        var id int64
        var status, customer, createdAt string
        var totalCents int
        if err := rows.Scan(&id, &status, &customer, &totalCents, &createdAt); err != nil {
            break
        }
        orders = append(orders, map[string]any{
            "id":          id,
            "status":      status,
            "customer":    customer,
            "total_cents": totalCents,
            "created_at":  createdAt,
        })
    }
    _ = rows.Err()

    http.WriteJSON(w, http.StatusOK, map[string]any{"orders": orders})
})
```

---

## Frontend: stat cards

The admin panel renders stat cards using Mantine's `Card` and `ThemeIcon` components. The reusable `StatCard` pattern:

```tsx
function StatCard({
  title,
  value,
  icon: Icon,
  color,
}: {
  title: string;
  value: string | number;
  icon: React.FC<{ size?: number; stroke?: number }>;
  color: string;
}) {
  return (
    <Card withBorder padding="lg" radius="md">
      <Group justify="space-between" wrap="nowrap">
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            {title}
          </Text>
          <Text fw={700} size="xl" mt={4}>
            {value}
          </Text>
        </div>
        <ThemeIcon size={48} radius="md" variant="light" color={color}>
          <Icon size={24} stroke={1.5} />
        </ThemeIcon>
      </Group>
    </Card>
  );
}
```

Render stat cards in a responsive grid — 4 columns on desktop, 2 on tablet, 1 on mobile:

```tsx
<SimpleGrid cols={{ base: 1, xs: 2, md: 4 }}>
  <StatCard title="Users" value={data.stats.total_users} icon={IconUsers} color="blue" />
  <StatCard title="Active Sessions" value={data.stats.active_sessions} icon={IconServer} color="green" />
  <StatCard title="Database" value={formatBytes(data.database.size_bytes)} icon={IconDatabase} color="violet" />
  <StatCard title="Uptime" value={data.system.uptime} icon={IconClock} color="orange" />
</SimpleGrid>
```

### Adding domain-specific stat cards

For your "Orders" module, add new stat cards that read from the response:

```tsx
<SimpleGrid cols={{ base: 1, xs: 2, md: 4 }}>
  {/* Existing cards... */}
  <StatCard title="Orders" value={data.orders.total} icon={IconShoppingCart} color="teal" />
  <StatCard title="Pending" value={data.orders.pending} icon={IconClock} color="yellow" />
  <StatCard
    title="Today's Revenue"
    value={`$${(data.orders.today_revenue / 100).toFixed(2)}`}
    icon={IconCash}
    color="green"
  />
</SimpleGrid>
```

---

## Frontend: charts

Charts use Mantine Charts (`@mantine/charts`), which wraps Recharts. Two chart types cover most dashboard needs: `AreaChart` for trends and `BarChart` for comparisons.

### Area chart (single series)

```tsx
import { AreaChart } from "@mantine/charts";

<Card withBorder padding="lg" radius="md">
  <Text size="sm" c="dimmed" mb="sm">New Users</Text>
  <AreaChart
    h={180}
    data={charts.users.map((d) => ({
      date: formatDate(d.date),
      Users: d.count,
    }))}
    dataKey="date"
    series={[{ name: "Users", color: "blue.6" }]}
    curveType="monotone"
    withDots={false}
    withGradient
    gridAxis="x"
    tickLine="none"
    withXAxis={false}
    withYAxis={false}
  />
</Card>
```

### Bar chart (multi-series)

```tsx
import { BarChart } from "@mantine/charts";

<Card withBorder padding="lg" radius="md">
  <Text size="sm" c="dimmed" mb="sm">Job Queue</Text>
  <BarChart
    h={180}
    data={charts.jobs.map((d) => ({
      date: formatDate(d.date),
      Completed: d.completed,
      Failed: d.failed,
    }))}
    dataKey="date"
    series={[
      { name: "Completed", color: "green.6" },
      { name: "Failed", color: "red.6" },
    ]}
    tickLine="none"
    withXAxis={false}
    withYAxis={false}
  />
</Card>
```

### Period selector

Let users switch between 7-day, 30-day, and 90-day views:

```tsx
const [period, setPeriod] = useState("7d");

useEffect(() => {
  get<ChartsData>(`/admin/dashboard/charts?period=${period}`)
    .then(setCharts)
    .catch(() => {}); // Charts are non-critical.
}, [period]);

<Group justify="space-between" align="center">
  <Text fw={600}>Trends</Text>
  <SegmentedControl
    size="xs"
    value={period}
    onChange={setPeriod}
    data={[
      { label: "7 days", value: "7d" },
      { label: "30 days", value: "30d" },
      { label: "90 days", value: "90d" },
    ]}
  />
</Group>
```

### Adding a chart for your module

Add your chart to the charts endpoint, then render it alongside the existing charts:

```tsx
<Grid.Col span={{ base: 12, md: 4 }}>
  <Card withBorder padding="lg" radius="md">
    <Text size="sm" c="dimmed" mb="sm">Orders</Text>
    <AreaChart
      h={180}
      data={charts.orders.map((d) => ({
        date: formatDate(d.date),
        Orders: d.count,
      }))}
      dataKey="date"
      series={[{ name: "Orders", color: "teal.6" }]}
      curveType="monotone"
      withDots={false}
      withGradient
      gridAxis="x"
      tickLine="none"
      withXAxis={false}
      withYAxis={false}
    />
  </Card>
</Grid.Col>
```

---

## Frontend: activity feed

The activity feed uses Mantine's `Timeline` component to show a chronological list of recent actions:

```tsx
<Card withBorder padding="lg" radius="md">
  <Text fw={600} mb="md">Recent Activity</Text>
  <Timeline bulletSize={24} lineWidth={2}>
    {activity.map((entry) => (
      <Timeline.Item
        key={entry.id}
        bullet={
          <Text size="xs" fw={700}>
            {(entry.admin_name || entry.admin_email || "?").charAt(0).toUpperCase()}
          </Text>
        }
      >
        <Group gap="xs" wrap="wrap">
          <Text size="sm" fw={500}>{entry.admin_name || entry.admin_email}</Text>
          <Badge size="sm" variant="light" color={actionColor(entry.action)}>
            {entry.action}
          </Badge>
          {entry.entity_type && (
            <Text size="sm" c="dimmed">
              {entry.entity_type}{entry.entity_id ? ` #${entry.entity_id}` : ""}
            </Text>
          )}
        </Group>
        {entry.details && <Text size="xs" c="dimmed" mt={2}>{entry.details}</Text>}
        <Text size="xs" c="dimmed" mt={2}>{timeAgo(entry.created_at)}</Text>
      </Timeline.Item>
    ))}
  </Timeline>
</Card>
```

### Color-coding actions

Map action names to colors for visual differentiation:

```tsx
const ACTION_COLORS: Record<string, string> = {
  create: "green",
  update: "blue",
  delete: "red",
  login: "cyan",
  logout: "gray",
  revoke: "orange",
  export: "violet",
};

function actionColor(action: string): string {
  for (const [key, color] of Object.entries(ACTION_COLORS)) {
    if (action.toLowerCase().includes(key)) return color;
  }
  return "gray";
}
```

### Helper: relative time

```tsx
function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
```

---

## Frontend: detail cards

For key-value detail panels (system info, database stats), use Mantine's `Card` with `Stack` and `Group`:

```tsx
<Card withBorder padding="lg" radius="md">
  <Text fw={600} mb="sm">System</Text>
  <Stack gap={4}>
    <Group justify="space-between">
      <Text size="sm" c="dimmed">Go Version</Text>
      <Text size="sm">{data.system.go_version}</Text>
    </Group>
    <Group justify="space-between">
      <Text size="sm" c="dimmed">Goroutines</Text>
      <Text size="sm">{data.system.goroutines}</Text>
    </Group>
    <Group justify="space-between">
      <Text size="sm" c="dimmed">Memory</Text>
      <Text size="sm">{data.system.memory_alloc_mb.toFixed(1)} MB</Text>
    </Group>
  </Stack>
</Card>
```

Arrange detail cards in a responsive 2-column grid:

```tsx
<Grid>
  <Grid.Col span={{ base: 12, md: 6 }}>
    {/* System card */}
  </Grid.Col>
  <Grid.Col span={{ base: 12, md: 6 }}>
    {/* Database card */}
  </Grid.Col>
</Grid>
```

### Conditional formatting

Highlight concerning values (failed jobs, high memory) with Mantine's color system:

```tsx
<Text size="sm" c={data.queue.failed > 0 ? "red" : undefined}>
  {data.queue.failed}
</Text>
```

---

## Data loading pattern

The dashboard loads data from three sources on mount, then polls the stats endpoint periodically:

```tsx
export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [charts, setCharts] = useState<ChartsData | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);

  const loadStats = useCallback(async () => {
    setData(await get<DashboardData>("/admin/dashboard"));
  }, []);

  const loadCharts = useCallback(async (period: string) => {
    try {
      setCharts(await get<ChartsData>(`/admin/dashboard/charts?period=${period}`));
    } catch {
      // Non-critical — silently fail.
    }
  }, []);

  const loadActivity = useCallback(async () => {
    try {
      const res = await get<{ entries: ActivityEntry[] }>("/admin/audit/recent");
      setActivity(res.entries);
    } catch {
      // Non-critical — silently fail.
    }
  }, []);

  // Load all on mount.
  useEffect(() => {
    loadStats();
    loadActivity();
  }, [loadStats, loadActivity]);

  // Show loader until main data arrives.
  if (!data) {
    return <Group justify="center" pt="xl"><Loader /></Group>;
  }

  return <Stack>{/* ... */}</Stack>;
}
```

The key design: only the main stats endpoint failure shows an error state. Charts and activity feed fail silently — they're supplementary data. The dashboard should render even if a secondary request fails.

---

## Tips

- **One endpoint per concern.** Main stats at `GET /dashboard`, charts at `GET /dashboard/charts`, activity at `GET /audit/recent`. Don't combine them — they have different cache durations and the frontend loads them independently.
- **Cache by TTL, not by invalidation.** Don't try to invalidate the dashboard cache when data changes. A 30-second TTL means the dashboard is at most 30 seconds stale — good enough for monitoring. Cache invalidation adds complexity for no practical benefit here.
- **Format on the frontend, not the API.** Return raw values (bytes, cents, seconds) from the API. Let the frontend format them (`formatBytes`, currency formatting, `timeAgo`). This keeps the API clean and the frontend flexible.
- **Charts are non-critical.** If a chart query fails or returns empty data, the dashboard still works. Don't let chart errors block the main stats render.
- **Use `CoalesceEmpty` in joins.** When joining tables for display (e.g., `audit_log` → `admins`), always wrap nullable fields with `sqlite.CoalesceEmpty("col")` to convert NULL to empty strings. This prevents `null` values from leaking into your JSON response.
- **Limit activity feeds.** Hard-limit to 10 entries. Don't paginate. The dashboard shows a snapshot — link to the full audit log page for historical data.
- **Keep chart rendering minimal.** Disable axes (`withXAxis={false}`, `withYAxis={false}`), dots, and grid lines for dashboard-sized charts. These decorations make sense in full-page chart views but add visual noise in small dashboard cards.
