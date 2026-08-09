import Link from "next/link";
import { requireInventoryPermission } from "../inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { listItems, getOnHand, listLocations } from "@/server/inventory/read";
import { listBranches } from "@/server/branches/service";
import { getTenantById } from "@/server/tenancy";
import { getCapabilities, type VerticalId } from "@/server/verticals";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { StockMovementForms } from "./StockMovementForms";

export default async function InventoryPage() {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:view");
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return (
        <>
          <PageHeader eyebrow="Inventory" title="Stock on hand" />
          <EmptyState title="Not authorized" description="Viewing inventory needs the inventory:view permission." />
        </>
      );
    }
    throw e; // requireDashboardUser redirects unauthenticated users
  }

  const PAGE_SIZE = 200;
  const [fetched, onHand, locations, branches, tenant] = await Promise.all([
    listItems(ctx.tenantId, { isActive: true, limit: PAGE_SIZE + 1 }),
    getOnHand(ctx.tenantId),
    listLocations(ctx.tenantId),
    listBranches(ctx.tenantId),
    getTenantById(ctx.tenantId),
  ]);
  const truncated = fetched.length > PAGE_SIZE;
  const items = truncated ? fetched.slice(0, PAGE_SIZE) : fetched;
  const caps = getCapabilities((tenant?.vertical ?? "restaurant") as VerticalId);

  // On-hand is per (item, location) — grouped under each item rather than
  // collapsed into one total, which is the whole point of a per-branch ledger.
  const byItem = new Map<string, typeof onHand>();
  for (const row of onHand) {
    const list = byItem.get(row.itemId) ?? [];
    list.push(row);
    byItem.set(row.itemId, list);
  }

  const actions = (
    <div className="flex flex-wrap gap-2">
      {caps.recipes && (
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/inventory/recipes">Recipes</Link>
        </Button>
      )}
      <Button asChild size="sm">
        <Link href="/dashboard/inventory/items/new">New item</Link>
      </Button>
    </div>
  );

  if (items.length === 0) {
    return (
      <>
        <PageHeader eyebrow="Inventory" title="Stock on hand" action={actions} />
        <EmptyState
          title="No stock items yet"
          description={caps.recipes
            ? "Create the ingredients you hold, then build recipes so selling a dish deducts them."
            : "Create the items you hold, then receive stock against them."}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow="Inventory" title="Stock on hand" action={actions} />

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const rows = byItem.get(item.id) ?? [];
              const cells = rows.length > 0 ? rows : [null];
              return cells.map((row, i) => (
                <TableRow key={`${item.id}-${row?.locationId ?? "none"}`}>
                  <TableCell className="font-medium">
                    {i === 0 ? item.nameEn : ""}
                    {i === 0 && item.isPerishable && (
                      <Badge variant="secondary" className="ml-2 align-middle">perishable</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{i === 0 ? item.kind.replace(/_/g, " ") : ""}</TableCell>
                  <TableCell className="font-mono text-xs">{i === 0 ? item.baseUom : ""}</TableCell>
                  <TableCell>{row?.locationName ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  {/* Negative on-hand is a real state — a kitchen that oversold —
                      and is surfaced rather than clamped, because it is the thing
                      that needs acting on. */}
                  <TableCell className={`text-right tabular-nums ${row && row.onHand < 0 ? "text-destructive font-semibold" : ""}`}>
                    {row ? row.onHand : 0}
                  </TableCell>
                  <TableCell className="text-right">
                    {i === 0 && (
                      <StockMovementForms
                        item={{ id: item.id, nameEn: item.nameEn, baseUom: item.baseUom }}
                        locations={locations.map((l) => ({ id: l.id, name: l.name, kind: l.kind }))}
                        branchId={branches[0]?.id ?? ""}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ));
            })}
          </TableBody>
        </Table>
      </Card>

      {truncated && (
        <p className="mt-3 text-sm text-muted-foreground">
          Showing the first {PAGE_SIZE} items. Narrow the list via <code>/api/inventory/items</code> until paging lands here.
        </p>
      )}
    </>
  );
}
