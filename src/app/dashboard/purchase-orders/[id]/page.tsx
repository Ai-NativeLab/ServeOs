import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requirePurchasingPermission } from "../../purchasing-permission";
import { getPurchaseOrder } from "@/server/purchasing/service";
import { getPoVariance } from "@/server/purchasing/variance";
import { getSupplier } from "@/server/purchasing/suppliers";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { formatUnitRate } from "@/server/purchasing/amounts";
import type { PoStatus } from "@/server/purchasing/status";
import { VarianceStrip } from "./VarianceStrip";
import { PoActionBar } from "./PoActionBar";

const STATUS_META: Record<PoStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
  sent: { label: "Sent", cls: "bg-blue-500/10 text-blue-700" },
  partially_received: { label: "Partially received", cls: "bg-amber-500/10 text-amber-700" },
  received: { label: "Received", cls: "bg-green-500/10 text-green-700" },
  closed: { label: "Closed", cls: "bg-slate-500/10 text-slate-700" },
  cancelled: { label: "Cancelled", cls: "bg-red-500/10 text-red-700" },
};

export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePurchasingPermission("purchasing:manage");

  const [po, variance] = await Promise.all([
    getPurchaseOrder(ctx.tenantId, id),
    getPoVariance(ctx.tenantId, id).catch(() => null),
  ]);

  if (!po) {
    notFound();
  }

  const supplier = await getSupplier(ctx.tenantId, po.supplierId);
  const statusMeta = STATUS_META[po.status as PoStatus] ?? { label: po.status, cls: "bg-muted" };

  return (
    <div className="space-y-6 max-w-5xl pb-12">
      <Link
        href="/dashboard/purchase-orders"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to purchase orders
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <PageHeader
          eyebrow="Purchase Order"
          title={`#${po.poNumber}`}
          description={`Addressed to ${supplier?.name ?? "Supplier"}`}
          action={
            <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${statusMeta.cls}`}>
              {statusMeta.label}
            </span>
          }
        />
        <PoActionBar
          po={{
            id: po.id,
            status: po.status as PoStatus,
            poNumber: po.poNumber,
            invoiceTotal: po.invoiceTotal,
            lines: po.lines.map((l) => ({
              id: l.id,
              itemId: l.itemId,
              itemNameEn: l.itemNameEn ?? "Item",
              qtyOrdered: Number(l.qtyOrdered),
              qtyReceived: Number(l.qtyReceived),
              uom: l.uom,
            })),
          }}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4 space-y-1">
          <div className="text-xs text-muted-foreground">Supplier</div>
          <div className="font-semibold">{supplier?.name ?? "—"}</div>
          <div className="text-xs text-muted-foreground">{supplier?.email ?? "No email"}</div>
        </Card>
        <Card className="p-4 space-y-1">
          <div className="text-xs text-muted-foreground">Expected Delivery</div>
          <div className="font-semibold">
            {po.expectedAt ? new Date(po.expectedAt).toLocaleDateString() : "Not specified"}
          </div>
          <div className="text-xs text-muted-foreground">
            Created {new Date(po.createdAt).toLocaleDateString()}
          </div>
        </Card>
        <Card className="p-4 space-y-1">
          <div className="text-xs text-muted-foreground">Order Total</div>
          <div className="font-semibold font-mono text-base">
            {po.total} {po.currency}
          </div>
          <div className="text-xs text-muted-foreground">
            {po.lines.length} {po.lines.length === 1 ? "line" : "lines"}
          </div>
        </Card>
      </div>

      {variance && (
        <VarianceStrip variance={variance} currency={po.currency} />
      )}

      {/* Ordered Lines Table */}
      <Card className="p-0 overflow-hidden">
        <div className="p-4 border-b">
          <h2 className="font-semibold text-sm">Line Items</h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="eyebrow">Item</TableHead>
              <TableHead className="eyebrow">UoM</TableHead>
              <TableHead className="eyebrow">Unit Cost</TableHead>
              <TableHead className="eyebrow">Tax Rate</TableHead>
              <TableHead className="eyebrow">Ordered</TableHead>
              <TableHead className="eyebrow">Received</TableHead>
              <TableHead className="eyebrow text-right">Subtotal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {po.lines.map((l) => {
              const lineSubtotal =
                Number(l.qtyOrdered) * Number(l.unitCost) * (1 + Number(l.taxRate ?? 0));
              return (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.itemNameEn ?? "—"}</TableCell>
                  <TableCell className="uppercase text-muted-foreground">{l.uom}</TableCell>
                  <TableCell className="font-mono">{formatUnitRate(l.unitCost)}</TableCell>
                  <TableCell>
                    {l.taxRate ? `${(Number(l.taxRate) * 100).toFixed(0)}%` : "0%"}
                  </TableCell>
                  <TableCell className="font-mono">{l.qtyOrdered}</TableCell>
                  <TableCell className="font-mono font-medium">
                    <span
                      className={
                        Number(l.qtyReceived) >= Number(l.qtyOrdered)
                          ? "text-green-600"
                          : Number(l.qtyReceived) > 0
                          ? "text-amber-600"
                          : "text-muted-foreground"
                      }
                    >
                      {l.qtyReceived}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono font-medium">
                    {lineSubtotal.toFixed(2)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {/* Receipts History */}
      <Card className="p-0 overflow-hidden">
        <div className="p-4 border-b">
          <h2 className="font-semibold text-sm">Posted Receipts ({po.receipts.length})</h2>
        </div>
        {po.receipts.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No stock receipts posted yet. Receive stock once delivered.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="eyebrow">Receipt Date</TableHead>
                <TableHead className="eyebrow">Delivery Note</TableHead>
                <TableHead className="eyebrow">Received At</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {po.receipts.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    {new Date(r.receivedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>{r.supplierDeliveryNote ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(r.receivedAt).toLocaleTimeString()}
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
