import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePurchasingPermission } from "../../purchasing-permission";
import { listReorderRules } from "@/server/purchasing/reorder";
import { listItems, listLocations } from "@/server/inventory/read";
import { listSuppliers } from "@/server/purchasing/suppliers";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ReorderRuleHeaderActions } from "./ReorderRuleForm";

export default async function ReorderRulesPage() {
  const ctx = await requirePurchasingPermission("purchasing:manage");

  const [rules, items, locations, suppliers] = await Promise.all([
    listReorderRules(ctx.tenantId),
    listItems(ctx.tenantId, { isActive: true, limit: 200 }),
    listLocations(ctx.tenantId),
    listSuppliers(ctx.tenantId),
  ]);

  const itemOptions = items.map((it) => ({
    id: it.id,
    nameEn: it.nameEn,
    sku: it.sku,
  }));

  const locationOptions = locations.map((loc) => ({
    id: loc.id,
    name: loc.name,
  }));

  const supplierOptions = suppliers.map((s) => ({
    id: s.id,
    name: s.name,
  }));

  return (
    <div className="space-y-6 max-w-5xl pb-12">
      <Link
        href="/dashboard/purchase-orders"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to purchase orders
      </Link>

      <PageHeader
        eyebrow="Purchasing"
        title="Reorder rules"
        description="Configure automated replenishment thresholds per item and storage location."
        action={
          <ReorderRuleHeaderActions
            items={itemOptions}
            locations={locationOptions}
            suppliers={supplierOptions}
          />
        }
      />

      <Card className="p-0 overflow-hidden">
        {rules.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No reorder rules configured yet. Add your first rule above to automate low-stock drafts.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="eyebrow">Item</TableHead>
                <TableHead className="eyebrow">Location</TableHead>
                <TableHead className="eyebrow">Reorder Point</TableHead>
                <TableHead className="eyebrow">Reorder Qty</TableHead>
                <TableHead className="eyebrow">Preferred Supplier</TableHead>
                <TableHead className="eyebrow">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.itemNameEn ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{r.locationName ?? "—"}</TableCell>
                  <TableCell className="font-mono">{r.reorderPoint}</TableCell>
                  <TableCell className="font-mono font-medium">{r.reorderQty}</TableCell>
                  <TableCell>{r.preferredSupplierName ?? "—"}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        r.isActive
                          ? "bg-green-500/10 text-green-700"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {r.isActive ? "Active" : "Inactive"}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
