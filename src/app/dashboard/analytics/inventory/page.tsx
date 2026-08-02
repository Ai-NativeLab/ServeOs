import { requireReportsPermission, requireAdvancedReports } from "../reports-permission";
import { FeatureNotAvailableError } from "@/server/entitlements/errors";
import {
  getInventoryValuation, getInventoryConsumption, getInventoryWastage,
  getCountVariance, getLowStock,
} from "@/server/analytics/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { UpgradePrompt } from "../UpgradePrompt";
import { ReportsNav } from "../ReportsNav";
import { parseRange } from "../range";

/** Each section degrades independently while Spec 8 is pending. */
function PendingSpec({ what }: { what: string }) {
  return <p className="text-sm text-muted-foreground">{what} arrives with Inventory Core (Spec 8).</p>;
}

export default async function InventoryReportsPage({
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
      title="Inventory reports"
      description="Valuation, consumption, wastage, count variance and low stock."
      action={<ReportsNav current="/dashboard/analytics/inventory" days={days} />}
    />
  );

  try {
    await requireAdvancedReports(ctx.tenantId);
  } catch (e) {
    if (e instanceof FeatureNotAvailableError) return <>{header}<UpgradePrompt /></>;
    throw e;
  }

  const [valuation, consumption, wastage, variance, lowStock] = await Promise.all([
    getInventoryValuation(ctx.tenantId),
    getInventoryConsumption(ctx.tenantId, days),
    getInventoryWastage(ctx.tenantId, days),
    getCountVariance(ctx.tenantId, days),
    getLowStock(ctx.tenantId),
  ]);

  return (
    <>
      {header}

      <div className="grid gap-6 mb-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Stock valuation</h2>
          {valuation.length === 0 ? <PendingSpec what="Valuation" /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="eyebrow">Item</TableHead>
                  <TableHead className="eyebrow text-right">On hand</TableHead>
                  <TableHead className="eyebrow text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {valuation.map((v) => (
                  <TableRow key={v.itemId}>
                    <TableCell className="font-medium">{v.name}</TableCell>
                    <TableCell className="text-right font-mono">{v.onHand}</TableCell>
                    <TableCell className="text-right font-mono">{v.value.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Low stock</h2>
          {lowStock.length === 0 ? <PendingSpec what="Low-stock alerting" /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="eyebrow">Item</TableHead>
                  <TableHead className="eyebrow text-right">On hand</TableHead>
                  <TableHead className="eyebrow text-right">Reorder at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lowStock.map((v) => (
                  <TableRow key={`${v.itemId}-${v.locationId}`}>
                    <TableCell className="font-medium">{v.name}</TableCell>
                    <TableCell className="text-right font-mono">{v.onHand}</TableCell>
                    <TableCell className="text-right font-mono">{v.reorderPoint}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Consumption</h2>
          {consumption.length === 0 ? <PendingSpec what="Consumption tracking" /> : (
            <ul className="space-y-2 text-sm">
              {consumption.map((c) => (
                <li key={c.itemId} className="flex justify-between">
                  <span className="font-medium">{c.name}</span>
                  <span className="font-mono">{c.consumed}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Wastage</h2>
          {wastage.length === 0 ? <PendingSpec what="Wastage tracking" /> : (
            <ul className="space-y-2 text-sm">
              {wastage.map((w) => (
                <li key={w.itemId} className="flex justify-between">
                  <span className="font-medium">{w.name}</span>
                  <span className="font-mono">{w.wasted}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Count variance</h2>
          {variance.length === 0 ? <PendingSpec what="Count variance" /> : (
            <ul className="space-y-2 text-sm">
              {variance.map((v) => (
                <li key={`${v.countId}-${v.itemId}`} className="flex justify-between">
                  <span className="font-medium">{v.name}</span>
                  <span className="font-mono">{v.variance > 0 ? "+" : ""}{v.variance}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
