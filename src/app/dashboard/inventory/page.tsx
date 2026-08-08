import { requireInventoryPermission } from "../inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { listItems, getOnHand } from "@/server/inventory/read";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export default async function InventoryPage() {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:view");
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return (
        <>
          <PageHeader eyebrow="Inventory" title="Stock on hand" />
          <EmptyState
            title="Not authorized"
            description="Viewing inventory needs the inventory:view permission."
          />
        </>
      );
    }
    throw e; // requireDashboardUser redirects unauthenticated users
  }

  // Ask for one more than we render so the page can say it is truncated instead
  // of silently showing 50 rows of 300 — this screen exists to surface negative
  // on-hand, and an item hidden past the cut is exactly what must not go unseen.
  const PAGE_SIZE = 200;
  const [fetched, onHand] = await Promise.all([
    listItems(ctx.tenantId, { isActive: true, limit: PAGE_SIZE + 1 }),
    getOnHand(ctx.tenantId),
  ]);
  const truncated = fetched.length > PAGE_SIZE;
  const items = truncated ? fetched.slice(0, PAGE_SIZE) : fetched;

  // On-hand is per (item, location), so group it under each item rather than
  // collapsing branches into one misleading total.
  const byItem = new Map<string, typeof onHand>();
  for (const row of onHand) {
    const list = byItem.get(row.itemId) ?? [];
    list.push(row);
    byItem.set(row.itemId, list);
  }

  if (items.length === 0) {
    return (
      <>
        <PageHeader eyebrow="Inventory" title="Stock on hand" />
        <EmptyState
          title="No stock items yet"
          description="Inventory items are created when you receive stock, link a product to finished goods, or build a recipe."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow="Inventory" title="Stock on hand" />
      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Base unit</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">On hand</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const rows = byItem.get(item.id) ?? [];
              if (rows.length === 0) {
                return (
                  <TableRow key={item.id}>
                    <TableCell>{item.nameEn}</TableCell>
                    <TableCell>{item.kind.replace(/_/g, " ")}</TableCell>
                    <TableCell>{item.baseUom}</TableCell>
                    <TableCell className="text-muted-foreground">—</TableCell>
                    <TableCell className="text-right text-muted-foreground">0</TableCell>
                  </TableRow>
                );
              }
              return rows.map((row, i) => (
                <TableRow key={`${item.id}-${row.locationId}`}>
                  <TableCell>{i === 0 ? item.nameEn : ""}</TableCell>
                  <TableCell>{i === 0 ? item.kind.replace(/_/g, " ") : ""}</TableCell>
                  <TableCell>{i === 0 ? item.baseUom : ""}</TableCell>
                  <TableCell>{row.locationName}</TableCell>
                  {/* Negative on-hand is a real state (a kitchen oversold) and is
                      surfaced, not clamped, because it is what needs acting on. */}
                  <TableCell className={`text-right ${row.onHand < 0 ? "text-destructive font-medium" : ""}`}>
                    {row.onHand}
                  </TableCell>
                </TableRow>
              ));
            })}
          </TableBody>
        </Table>
      </Card>
      {truncated && (
        <p className="mt-3 text-sm text-muted-foreground">
          Showing the first {PAGE_SIZE} items. Narrow the list with the inventory API
          (<code>/api/inventory/items</code>) until paging lands here.
        </p>
      )}
    </>
  );
}
