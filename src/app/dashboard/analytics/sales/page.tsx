import { requireReportsPermission, requireAdvancedReports } from "../reports-permission";
import { FeatureNotAvailableError } from "@/server/entitlements/errors";
import {
  getSalesByBranch, getSalesByCashier, getSalesByPaymentMethod,
} from "@/server/analytics/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { BreakdownChart } from "../BreakdownChart";
import { UpgradePrompt } from "../UpgradePrompt";
import { ReportsNav } from "../ReportsNav";
import { parseRange } from "../range";

export default async function SalesBreakdownsPage({
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
      title="Sales breakdowns"
      description="Where the take comes from — branch, cashier and payment method."
      action={<ReportsNav current="/dashboard/analytics/sales" days={days} />}
    />
  );

  try {
    await requireAdvancedReports(ctx.tenantId);
  } catch (e) {
    if (e instanceof FeatureNotAvailableError) return <>{header}<UpgradePrompt /></>;
    throw e;
  }

  const [byBranch, byCashier, byMethod] = await Promise.all([
    getSalesByBranch(ctx.tenantId, days),
    getSalesByCashier(ctx.tenantId, days),
    getSalesByPaymentMethod(ctx.tenantId, days),
  ]);

  if (byBranch.length === 0) {
    return (
      <>
        {header}
        <EmptyState title="No sales in this period" description="Breakdowns appear once orders come in." />
      </>
    );
  }

  return (
    <>
      {header}

      <Card className="p-5 mb-6">
        <h2 className="eyebrow text-primary mb-3">Revenue by branch</h2>
        <BreakdownChart data={byBranch.map((b) => ({ label: b.branchName, value: b.revenue }))} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Sales by cashier</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="eyebrow">Cashier</TableHead>
                <TableHead className="eyebrow text-right">Orders</TableHead>
                <TableHead className="eyebrow text-right">Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byCashier.map((c) => (
                <TableRow key={c.cashierUserId ?? "online"}>
                  <TableCell className="font-medium">{c.cashierName ?? "Online orders"}</TableCell>
                  <TableCell className="text-right font-mono">{c.orderCount}</TableCell>
                  <TableCell className="text-right font-mono">{c.revenue.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Sales by payment method</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="eyebrow">Method</TableHead>
                <TableHead className="eyebrow text-right">Payments</TableHead>
                <TableHead className="eyebrow text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byMethod.map((m) => (
                <TableRow key={m.method}>
                  <TableCell className="font-medium capitalize">{m.method}</TableCell>
                  <TableCell className="text-right font-mono">{m.count}</TableCell>
                  <TableCell className="text-right font-mono">{m.amount.toFixed(2)}</TableCell>
                </TableRow>
              ))}
              {byMethod.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-sm text-muted-foreground">
                    No POS payments in this period — online orders settle outside the till.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
