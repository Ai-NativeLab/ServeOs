import { requirePurchasingPermission } from "../purchasing-permission";
import { listPurchaseOrders } from "@/server/purchasing/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import type { PoStatus } from "@/server/purchasing/status";

const STATUS_META: Record<PoStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
  sent: { label: "Sent", cls: "bg-blue-500/10 text-blue-700" },
  partially_received: { label: "Partially received", cls: "bg-amber-500/10 text-amber-700" },
  received: { label: "Received", cls: "bg-green-500/10 text-green-700" },
  closed: { label: "Closed", cls: "bg-slate-500/10 text-slate-700" },
  cancelled: { label: "Cancelled", cls: "bg-red-500/10 text-red-700" },
};

export default async function PurchaseOrdersPage() {
  const ctx = await requirePurchasingPermission("purchasing:manage");
  const orders = await listPurchaseOrders(ctx.tenantId);

  return (
    <>
      <PageHeader
        eyebrow="Purchasing"
        title="Purchase orders"
        description="Drafts to send, and sent orders awaiting delivery, receipts and the final invoice."
      />

      {orders.length === 0 ? (
        <EmptyState
          title="No purchase orders yet"
          description="Draft a PO from a supplier when stock needs replenishing, or let a reorder rule pre-fill one."
        />
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="eyebrow">Number</TableHead>
                <TableHead className="eyebrow">Status</TableHead>
                <TableHead className="eyebrow">Total</TableHead>
                <TableHead className="eyebrow">Expected</TableHead>
                <TableHead className="eyebrow">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((po) => {
                const meta = STATUS_META[po.status];
                return (
                  <TableRow key={po.id}>
                    <TableCell className="font-medium">#{po.poNumber}</TableCell>
                    <TableCell>
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${meta.cls}`}>
                        {meta.label}
                      </span>
                    </TableCell>
                    <TableCell>{po.total} {po.currency}</TableCell>
                    <TableCell className="text-muted-foreground">{po.expectedAt?.toLocaleDateString() ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{po.createdAt.toLocaleDateString()}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
