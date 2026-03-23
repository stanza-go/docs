---
title: Adding an admin page
nextjs:
  metadata:
    title: Adding an admin page
    description: Step-by-step guide to creating a new admin page with data table, CRUD modals, and bulk actions.
---

This recipe walks through creating a new admin page from scratch — a "Products" page with a data table, search, sort, pagination, CRUD modals, bulk actions, and CSV export. This is the frontend counterpart of the [Adding a module](/recipes/modules) recipe.

The admin panel lives in `admin/` and uses React, Mantine UI, and React Router.

---

## Architecture overview

Every admin page follows the same pattern:

1. **Lazy-loaded route** in `App.tsx` — code-split automatically
2. **Single page component** in `src/pages/{name}.tsx` — self-contained
3. **Shared hooks** for debounce, sort, and selection
4. **API layer** at `src/lib/api.ts` — typed fetch wrapper with error handling
5. **Mantine components** for UI — Table, Modal, TextInput, notifications

---

## Step 1: Create the page component

Create `admin/src/pages/products.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import {
  IconCheck,
  IconDownload,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { ApiError, del, downloadCSV, get, post, put } from "@/lib/api";
import { useDebounce } from "@/hooks/use-debounce";
import { useSort } from "@/hooks/use-sort";
import { useSelection } from "@/hooks/use-selection";

const PAGE_SIZE = 20;

interface Product {
  id: number;
  name: string;
  description: string;
  price_cents: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounce(searchInput, 300);
  const [sort, toggleSort] = useSort("id", "desc");
  const selection = useSelection();
  const [loading, setLoading] = useState(true);

  // Modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const load = useCallback(async () => {
    const offset = (page - 1) * PAGE_SIZE;
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort: sort.column,
      order: sort.direction.toUpperCase(),
    });
    if (search) params.set("search", search);

    const data = await get<{ products: Product[]; total: number }>(
      `/admin/products?${params}`
    );
    setProducts(data.products ?? []);
    setTotal(data.total);
    setLoading(false);
  }, [page, search, sort]);

  useEffect(() => { load(); }, [load]);

  // Clear selection when filters change
  useEffect(() => { selection.clear(); }, [search, page, sort]);

  // ... handlers and JSX below
}
```

---

## Step 2: Add CRUD handlers

Inside the page component, add handlers for each action. The pattern is consistent: set loading, try/catch with error mapping, reload on success, show notification.

### Create

```tsx
const createForm = useForm({
  initialValues: { name: "", description: "", price_cents: 0 },
  validate: {
    name: (v) => (v.trim() ? null : "Name is required"),
    price_cents: (v) => (v >= 0 ? null : "Price must be positive"),
  },
});

const handleCreate = async (values: typeof createForm.values) => {
  setActionLoading(true);
  try {
    await post("/admin/products", values);
    notifications.show({ message: "Product created", color: "green", icon: <IconCheck size={16} /> });
    setCreateOpen(false);
    createForm.reset();
    load();
  } catch (e) {
    if (e instanceof ApiError && Object.keys(e.fields).length > 0) {
      createForm.setErrors(e.fields);
    } else {
      notifications.show({ message: e instanceof ApiError ? e.message : "Failed to create", color: "red" });
    }
  } finally {
    setActionLoading(false);
  }
};
```

### Delete

```tsx
const handleDelete = async () => {
  if (!deleteTarget) return;
  setActionLoading(true);
  try {
    await del(`/admin/products/${deleteTarget.id}`);
    notifications.show({ message: "Product deleted", color: "green", icon: <IconCheck size={16} /> });
    setDeleteTarget(null);
    load();
  } catch (e) {
    notifications.show({ message: "Failed to delete", color: "red" });
  } finally {
    setActionLoading(false);
  }
};
```

### Bulk delete

```tsx
const handleBulkDelete = async () => {
  setActionLoading(true);
  try {
    await post("/admin/products/bulk-delete", { ids: selection.ids });
    notifications.show({ message: `Deleted ${selection.count} products`, color: "green", icon: <IconCheck size={16} /> });
    setBulkDeleteOpen(false);
    selection.clear();
    load();
  } catch (e) {
    notifications.show({ message: "Bulk delete failed", color: "red" });
  } finally {
    setActionLoading(false);
  }
};
```

### CSV export

```tsx
const handleExport = () => {
  const params = new URLSearchParams({ sort: sort.column, order: sort.direction.toUpperCase() });
  if (search) params.set("search", search);
  downloadCSV(`/admin/products/export?${params}`);
};
```

---

## Step 3: Build the table

The table uses sortable headers, row selection, and inline actions:

```tsx
const SortHeader = ({ column, children }: { column: string; children: React.ReactNode }) => (
  <Table.Th onClick={() => toggleSort(column)} style={{ cursor: "pointer" }}>
    <Group gap={4}>
      {children}
      {sort.column === column && <Text size="xs">{sort.direction === "asc" ? "↑" : "↓"}</Text>}
    </Group>
  </Table.Th>
);

// In JSX:
return (
  <Stack>
    {/* Header */}
    <Group justify="space-between">
      <Text fw={600} size="lg">Products</Text>
      <Group>
        <TextInput
          placeholder="Search..."
          leftSection={<IconSearch size={16} />}
          value={searchInput}
          onChange={(e) => { setSearchInput(e.currentTarget.value); setPage(1); }}
        />
        <Button leftSection={<IconDownload size={16} />} variant="default" onClick={handleExport}>
          Export
        </Button>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
          Add Product
        </Button>
      </Group>
    </Group>

    {/* Table */}
    {loading ? (
      <Center pt="xl"><Loader /></Center>
    ) : (
      <Paper withBorder>
        <Table.ScrollContainer minWidth={600}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={40}>
                  <Checkbox
                    checked={selection.isAllSelected(products.map((p) => p.id))}
                    onChange={() => selection.toggleAll(products.map((p) => p.id))}
                  />
                </Table.Th>
                <SortHeader column="id">ID</SortHeader>
                <SortHeader column="name">Name</SortHeader>
                <SortHeader column="price_cents">Price</SortHeader>
                <Table.Th>Status</Table.Th>
                <SortHeader column="created_at">Created</SortHeader>
                <Table.Th w={80}>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {products.map((p) => (
                <Table.Tr key={p.id}>
                  <Table.Td>
                    <Checkbox
                      checked={selection.isSelected(p.id)}
                      onChange={() => selection.toggle(p.id)}
                    />
                  </Table.Td>
                  <Table.Td>{p.id}</Table.Td>
                  <Table.Td>{p.name}</Table.Td>
                  <Table.Td>${(p.price_cents / 100).toFixed(2)}</Table.Td>
                  <Table.Td>
                    <Badge color={p.is_active ? "green" : "gray"} variant="light">
                      {p.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={p.created_at}>
                      <Text size="sm" c="dimmed">{timeAgo(p.created_at)}</Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      <ActionIcon variant="subtle" onClick={() => setEditProduct(p)}>
                        <IconPencil size={16} />
                      </ActionIcon>
                      <ActionIcon variant="subtle" color="red" onClick={() => setDeleteTarget(p)}>
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
    )}

    {/* Pagination */}
    <Group justify="space-between">
      <Text size="sm" c="dimmed">{total} total</Text>
      <Pagination value={page} onChange={setPage} total={Math.ceil(total / PAGE_SIZE)} />
    </Group>
  </Stack>
);
```

---

## Step 4: Add modals

Use Mantine `Modal` with `useForm` for create and edit. Use a simple confirmation modal for delete:

```tsx
{/* Create modal */}
<Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Add Product">
  <form onSubmit={createForm.onSubmit(handleCreate)}>
    <Stack>
      <TextInput label="Name" {...createForm.getInputProps("name")} />
      <TextInput label="Description" {...createForm.getInputProps("description")} />
      <NumberInput label="Price (cents)" min={0} {...createForm.getInputProps("price_cents")} />
      <Button type="submit" loading={actionLoading}>Create</Button>
    </Stack>
  </form>
</Modal>

{/* Delete confirmation */}
<Modal opened={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Product">
  <Text>Delete "{deleteTarget?.name}"? This cannot be undone.</Text>
  <Group justify="flex-end" mt="md">
    <Button variant="default" onClick={() => setDeleteTarget(null)}>Cancel</Button>
    <Button color="red" onClick={handleDelete} loading={actionLoading}>Delete</Button>
  </Group>
</Modal>

{/* Bulk delete confirmation */}
<Modal opened={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)} title="Bulk Delete">
  <Text>Delete {selection.count} selected products?</Text>
  <Group justify="flex-end" mt="md">
    <Button variant="default" onClick={() => setBulkDeleteOpen(false)}>Cancel</Button>
    <Button color="red" onClick={handleBulkDelete} loading={actionLoading}>Delete All</Button>
  </Group>
</Modal>
```

---

## Step 5: Register the route

In `admin/src/App.tsx`, add the lazy import and route:

```tsx
const ProductsPage = lazy(() => import("@/pages/products"));

// Inside <Routes>:
<Route path="/products" element={<Suspense fallback={L}><ProductsPage /></Suspense>} />
```

Then add a navigation entry in `admin/src/components/layout/shell.tsx`:

```tsx
{ label: "Products", icon: IconPackage, href: "/products" }
```

---

## Shared hooks reference

The admin panel provides three composable hooks for common table patterns:

### useDebounce

```tsx
import { useDebounce } from "@/hooks/use-debounce";

const [searchInput, setSearchInput] = useState("");
const search = useDebounce(searchInput, 300);
// search updates 300ms after user stops typing
```

### useSort

```tsx
import { useSort } from "@/hooks/use-sort";

const [sort, toggleSort] = useSort("id", "desc");
// sort = { column: "id", direction: "desc" }
// toggleSort("id")   → flips to "asc"
// toggleSort("name") → resets to "desc" on new column
```

### useSelection

```tsx
import { useSelection } from "@/hooks/use-selection";

const selection = useSelection();
// selection.toggle(id)              — toggle one item
// selection.toggleAll(visibleIds)    — select all or clear all
// selection.isSelected(id)           — check one
// selection.isAllSelected(visibleIds) — check all
// selection.ids                      — number[] of selected
// selection.count                    — number of selected
// selection.clear()                  — clear selection
```

---

## API layer

All API calls go through `src/lib/api.ts`:

```tsx
import { get, post, put, del, downloadCSV, upload, ApiError } from "@/lib/api";

// Typed GET
const data = await get<{ products: Product[]; total: number }>("/admin/products?limit=20");

// POST with body
await post("/admin/products", { name: "Widget", price_cents: 999 });

// DELETE
await del(`/admin/products/${id}`);

// CSV download (streams to disk)
downloadCSV("/admin/products/export");

// File upload
await upload("/admin/uploads", file, { category: "product-images" });
```

The API layer automatically redirects to `/login` on 401 responses. `ApiError` carries both a message and field-level validation errors from the server:

```tsx
try {
  await post("/admin/products", values);
} catch (e) {
  if (e instanceof ApiError && Object.keys(e.fields).length > 0) {
    form.setErrors(e.fields); // populate field errors on the form
  } else {
    notifications.show({ message: e instanceof ApiError ? e.message : "Failed", color: "red" });
  }
}
```

---

## Key patterns

| Pattern | Detail |
|---------|--------|
| One file per page | `src/pages/{name}.tsx` |
| Lazy-loaded routes | `lazy(() => import("@/pages/{name}"))` with `Suspense` |
| Debounced search | `useDebounce(input, 300)` — delays API calls |
| Sort state | `useSort(defaultCol, defaultDir)` — toggle on header click |
| Set-based selection | `useSelection()` — O(1) membership checks |
| Clear selection on filter change | `useEffect(() => selection.clear(), [search, page, sort])` |
| Typed API calls | Generic `get<T>()`, `post<T>()` with `ApiError` handling |
| Form validation | Mantine `useForm` with `validate` + `setErrors` for server errors |
| Confirmation modals | Separate modal state per destructive action |
| Notifications | `notifications.show({ message, color, icon })` — green for success, red for error |
| Export | `downloadCSV(path)` — streams file to disk with filters preserved |
| Pagination | 1-indexed pages, `PAGE_SIZE` constant, `Math.ceil(total / PAGE_SIZE)` |
