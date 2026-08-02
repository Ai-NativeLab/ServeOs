import { requireReportsPermission, requireAdvancedReports, canFinancialReports } from "../reports-permission";
import { FeatureNotAvailableError } from "@/server/entitlements/errors";
import { recordFinancialView } from "@/server/audit/read-events";
import { actionAudit } from "@/server/audit/action-context";
import {
  getTendersAndTips, getReconciliationSummary, getRefundsAndVoids, getDiscountsGiven,
} from "@/server/analytics/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { UpgradePrompt } from "../UpgradePrompt";
import { ReportsNav } from "../ReportsNav";
import { parseRange } from "../range";

export default async function FinancialReportsPage({
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
      title="Financial reports"
      description="Tenders, tips, discounts, refunds and the daily reconciliation."
      action={<ReportsNav current="/dashboard/analytics/financial" days={days} />}
    />
  );

  // Server-side omission: without reports:financial nothing below is ever
  // computed or sent — not merely hidden.
  if (!canFinancialReports(ctx)) {
    return (
      <>
        {header}
        <EmptyState
          title="No access"
          description="Financial reports need the reports:financial permission. Ask an owner to grant it."
        />
      </>
    );
  }

  try {
    await requireAdvancedReports(ctx.tenantId);
  } catch (e) {
    if (e instanceof FeatureNotAvailableError) return <>{header}<UpgradePrompt /></>;
    throw e;
  }

  const [tenders, reconciliation, refundsAndVoids, discounts] = await Promise.all([
    getTendersAndTips(ctx.tenantId, days),
    getReconciliationSummary(ctx.tenantId, days),
    getRefundsAndVoids(ctx.tenantId, days),
    getDiscountsGiven(ctx.tenantId, days),
  ]);

  // Opening a financial report is a sensitive read — log THAT it was viewed.
  await recordFinancialView(ctx.tenantId, await actionAudit(ctx));

  return (
    <>
      {header}

      <div className="grid gap-6 mb-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Tenders &amp; tips</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="eyebrow">Method</TableHead>
                <TableHead className="eyebrow text-right">Count</TableHead>
                <TableHead className="eyebrow text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenders.byMethod.map((m) => (
                <TableRow key={m.method}>
                  <TableCell className="font-medium capitalize">{m.method}</TableCell>
                  <TableCell className="text-right font-mono">{m.count}</TableCell>
                  <TableCell className="text-right font-mono">{m.amount.toFixed(2)}</TableCell>
                </TableRow>
              ))}
              {tenders.byMethod.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-sm text-muted-foreground">No tenders in this period.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
            <div><dt className="text-muted-foreground">Tips</dt><dd className="font-mono text-ink">{tenders.tips.toFixed(2)}</dd></div>
            <div><dt className="text-muted-foreground">Cash tendered</dt><dd className="font-mono text-ink">{tenders.cashTendered.toFixed(2)}</dd></div>
            <div><dt className="text-muted-foreground">Change given</dt><dd className="font-mono text-ink">{tenders.cashChange.toFixed(2)}</dd></div>
          </dl>
        </Card>

        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Discounts given</h2>
          <div className="mb-3 font-display text-3xl font-bold text-ink">{discounts.total.toFixed(2)}</div>
          {discounts.byReason.length === 0 ? (
            <p className="text-sm text-muted-foreground">No discounts in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="eyebrow">Reason</TableHead>
                  <TableHead className="eyebrow text-right">Count</TableHead>
                  <TableHead className="eyebrow text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {discounts.byReason.map((r) => (
                  <TableRow key={r.reasonCode}>
                    <TableCell className="font-medium">{r.reasonCode}</TableCell>
                    <TableCell className="text-right font-mono">{r.count}</TableCell>
                    <TableCell className="text-right font-mono">{r.amount.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>

      <div className="grid gap-6 mb-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Voids</h2>
          {refundsAndVoids.voids.length === 0 ? (
            <p className="text-sm text-muted-foreground">No voids in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="eyebrow">Type</TableHead>
                  <TableHead className="eyebrow text-right">Count</TableHead>
                  <TableHead className="eyebrow text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {refundsAndVoids.voids.map((v) => (
                  <TableRow key={v.type}>
                    <TableCell className="font-medium">{v.type === "line_void" ? "Line void" : "Order void"}</TableCell>
                    <TableCell className="text-right font-mono">{v.count}</TableCell>
                    <TableCell className="text-right font-mono">{v.amount.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Refunds</h2>
          {refundsAndVoids.refunds === null ? (
            <p className="text-sm text-muted-foreground">Arrives with Refunds &amp; Sales History (Spec 3).</p>
          ) : (
            <div className="flex items-baseline gap-3">
              <span className="font-display text-3xl font-bold text-ink">{refundsAndVoids.refunds.amount.toFixed(2)}</span>
              <span className="text-sm text-muted-foreground">{refundsAndVoids.refunds.count} refunds</span>
            </div>
          )}
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="eyebrow text-primary mb-3">Daily reconciliation</h2>
        {reconciliation.length === 0 ? (
          <p className="text-sm text-muted-foreground">Arrives with Transaction Reconciliation (Spec 7).</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="eyebrow">Day</TableHead>
                <TableHead className="eyebrow text-right">Expected cash</TableHead>
                <TableHead className="eyebrow text-right">Counted</TableHead>
                <TableHead className="eyebrow text-right">Variance</TableHead>
                <TableHead className="eyebrow text-right">Matched</TableHead>
                <TableHead className="eyebrow text-right">Unmatched</TableHead>
                <TableHead className="eyebrow text-right">Fees</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reconciliation.map((r) => (
                <TableRow key={r.day}>
                  <TableCell className="font-medium">{r.day}</TableCell>
                  <TableCell className="text-right font-mono">{r.expectedCash.toFixed(2)}</TableCell>
                  <TableCell className="text-right font-mono">{r.countedCash.toFixed(2)}</TableCell>
                  <TableCell className="text-right font-mono">{r.variance.toFixed(2)}</TableCell>
                  <TableCell className="text-right font-mono">{r.matchedSettlementLines}</TableCell>
                  <TableCell className="text-right font-mono">{r.unmatchedSettlementLines}</TableCell>
                  <TableCell className="text-right font-mono">{r.fees.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
