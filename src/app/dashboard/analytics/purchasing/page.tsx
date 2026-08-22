import { requireReportsPermission, requireAdvancedReports } from "../reports-permission";
import { FeatureNotAvailableError } from "@/server/entitlements/errors";
import { getSpendBySupplier, getReceivedVsInvoiced } from "@/server/analytics/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { UpgradePrompt } from "../UpgradePrompt";
import { ReportsNav } from "../ReportsNav";
import { parseRange } from "../range";

export default async function PurchasingReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const ctx = await requireReportsPermission();
  const { range } = await searchParams;
  const days = parseRange(range);

  const header = (
    <PageHeader
      eyebrow="Insights"
      title="Purchasing reports"
      description="Supplier spend and received-vs-invoiced variance."
      action={<ReportsNav current="/dashboard/analytics/purchasing" days={days} />}
    />
  );

  try {
    await requireAdvancedReports(ctx.tenantId);
  } catch (e) {
    if (e instanceof FeatureNotAvailableError) return <>{header}<UpgradePrompt /></>;
    throw e;
  }

  const [spend, receivedVsInvoiced] = await Promise.all([
    getSpendBySupplier(ctx.tenantId, days),
    getReceivedVsInvoiced(ctx.tenantId, days),
  ]);

  return (
    <>
      {header}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Spend by supplier</h2>
          {spend.length === 0 ? (
            <p className="text-sm text-muted-foreground">Arrives with Suppliers &amp; Purchasing (Spec 9).</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="eyebrow">Supplier</TableHead>
                  <TableHead className="eyebrow text-right">POs</TableHead>
                  <TableHead className="eyebrow text-right">Spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {spend.map((s) => (
                  <TableRow key={s.supplierId}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell className="text-right font-mono">{s.poCount}</TableCell>
                    <TableCell className="text-right font-mono">{s.spend.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Received vs invoiced</h2>
          {receivedVsInvoiced.length === 0 ? (
            <p className="text-sm text-muted-foreground">Arrives with Suppliers &amp; Purchasing (Spec 9).</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="eyebrow">PO</TableHead>
                  <TableHead className="eyebrow text-right">Ordered</TableHead>
                  <TableHead className="eyebrow text-right">Received</TableHead>
                  <TableHead className="eyebrow text-right">Invoiced</TableHead>
                  <TableHead className="eyebrow text-right">Invoiced &minus; Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receivedVsInvoiced.map((r) => (
                  <TableRow key={r.poId}>
                    <TableCell className="font-medium">{r.poNumber}</TableCell>
                    <TableCell className="text-right font-mono">{r.ordered.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono">{r.received.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono">{r.invoiced.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono">{r.invoiceVsReceived.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
