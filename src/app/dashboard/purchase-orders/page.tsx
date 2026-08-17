import Link from "next/link";
import { requirePurchasingPermission } from "../purchasing-permission";
import { listPurchaseOrders } from "@/server/purchasing/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="outline" size="sm">
        <Link href="/dashboard/purchase-orders/reorder-rules">Reorder rules</Link>
      </Button>
      <Button asChild size="sm">
        <Link href="/dashboard/purchase-orders/new">Draft PO</Link>
      </Button>
    </div>
  );

  return (
    <>
      <PageHeader
        eyebrow="Purchasing"
        title="Purchase orders"
        description="Drafts to send, and sent orders awaiting delivery, receipts and the final invoice."
        action={actions}
      />

      {orders.length === 0 ? (
        <EmptyState
          title="No purchase orders yet"
          description="Draft a PO from a supplier when stock needs replenishing, or let a reorder rule pre-fill one."
          action={
            <Button asChild size="sm">
              <Link href="/dashboard/purchase-orders/new">Draft a purchase order</Link>
            </Button>
          }
        />
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="eyebrow">Number</TableHead>
                <TableHead className="eyebrow">Supplier</TableHead>
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
                  <TableRow key={po.id} className="cursor-pointer">
                    <TableCell className="font-medium">
                      <Link
                        href={`/dashboard/purchase-orders/${po.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        #{po.poNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{po.supplierName ?? "—"}</TableCell>
                    <TableCell>
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${meta.cls}`}>
                        {meta.label}
                      </span>
                    </TableCell>
                    <TableCell>{po.total} {po.currency}</TableCell>
                    <TableCell className="text-muted-foreground">{po.expectedAt ? new Date(po.expectedAt).toLocaleDateString() : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(po.createdAt).toLocaleDateString()}</TableCell>
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

