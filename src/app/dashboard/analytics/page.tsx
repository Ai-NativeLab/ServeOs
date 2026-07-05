import Link from "next/link";
import { requireMenuPermission } from "../menu-permission";
import {
  getRevenueTrend, getTopProducts, getOrdersByStatus, getFulfillmentSplit,
  getAverageOrderValue, getPeakHours,
} from "@/server/analytics/service";
import { orderStatusMeta } from "@/lib/order-status";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { RevenueChart } from "./RevenueChart";

const RANGES = ["7", "30", "90"] as const;

function parseRange(value: unknown): number {
  return RANGES.includes(value as (typeof RANGES)[number]) ? Number(value) : 30;
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { tenantId } = await requireMenuPermission();
  const { range } = await searchParams;
  const days = parseRange(range);

  const [revenueTrend, topProducts, byStatus, fulfillment, aov, peak] = await Promise.all([
    getRevenueTrend(tenantId, days),
    getTopProducts(tenantId, days),
    getOrdersByStatus(tenantId, days),
    getFulfillmentSplit(tenantId, days),
    getAverageOrderValue(tenantId, days),
    getPeakHours(tenantId, days),
  ]);

  if (revenueTrend.length === 0) {
    return (
      <EmptyState
        title="No orders yet"
        description="Analytics will appear once you start receiving orders."
      />
    );
  }

  const aovDelta = aov.previous > 0
    ? ((aov.current - aov.previous) / aov.previous) * 100
    : null;
  const peakMax = peak.reduce((m, c) => Math.max(m, c.count), 0);
  const peakMap = new Map(peak.map((c) => [`${c.dayOfWeek}-${c.hour}`, c.count]));

  return (
    <>
      <PageHeader
        eyebrow="Insights"
        title="Analytics"
        description="Track revenue, top products, and order patterns over time."
        action={
          <div className="flex items-center gap-1.5">
            {RANGES.map((r) => (
              <Button key={r} asChild variant={r === String(days) ? "default" : "outline"} size="sm">
                <Link href={`/dashboard/analytics?range=${r}`}>{r}d</Link>
              </Button>
            ))}
          </div>
        }
      />

      <Card className="p-5 mb-6">
        <h2 className="eyebrow text-primary mb-3">Revenue &amp; order volume</h2>
        <RevenueChart data={revenueTrend} />
      </Card>

      <div className="grid gap-6 mb-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Top products</h2>
          {topProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No product sales in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="eyebrow">Product</TableHead>
                  <TableHead className="eyebrow text-right">Qty sold</TableHead>
                  <TableHead className="eyebrow text-right">Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topProducts.map((p) => (
                  <TableRow key={p.productId}>
                    <TableCell className="font-medium">{p.nameEn}</TableCell>
                    <TableCell className="text-right font-mono">{p.quantity}</TableCell>
                    <TableCell className="text-right font-mono">{p.revenue.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <div className="grid gap-6">
          <Card className="p-5">
            <h2 className="eyebrow text-primary mb-3">Orders by status</h2>
            <ul className="space-y-2">
              {byStatus.map((s) => {
                const meta = orderStatusMeta(s.status as Parameters<typeof orderStatusMeta>[0]);
                return (
                  <li key={s.status} className="flex items-center justify-between text-sm">
                    <span className="inline-flex items-center gap-2">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.badgeClass}`}>
                        {meta.label}
                      </span>
                    </span>
                    <span className="font-mono text-ink">{s.count}</span>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card className="p-5">
            <h2 className="eyebrow text-primary mb-3">Fulfillment split</h2>
            <div className="flex gap-3">
              {fulfillment.map((f) => (
                <div key={f.fulfillmentType} className="flex-1 rounded-lg border bg-card p-3">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    {f.fulfillmentType}
                  </div>
                  <div className="font-display text-2xl font-bold text-ink">{f.count}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Card className="p-5 mb-6">
        <h2 className="eyebrow text-primary mb-3">Average order value</h2>
        <div className="flex items-baseline gap-3">
          <span className="font-display text-4xl font-bold text-ink">{aov.current.toFixed(2)}</span>
          {aovDelta !== null && (
            <span className={aovDelta >= 0 ? "text-sm font-medium text-status-ready-fg" : "text-sm font-medium text-status-danger-fg"}>
              {aovDelta >= 0 ? "+" : ""}{aovDelta.toFixed(1)}% vs previous period
            </span>
          )}
          {aovDelta === null && aov.current > 0 && (
            <span className="text-sm font-medium text-muted-foreground">No previous-period data</span>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="eyebrow text-primary mb-3">Peak hours</h2>
        <div className="overflow-x-auto">
          <div className="inline-grid gap-px" style={{ gridTemplateColumns: `auto repeat(24, minmax(18px, 1fr))` }}>
            <div />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="text-center text-[10px] text-muted-foreground pb-1">
                {h % 3 === 0 ? h : ""}
              </div>
            ))}
            {DOW_LABELS.map((dayLabel, dow) => (
              <DayRow key={dow} dow={dow} dayLabel={dayLabel} peakMap={peakMap} peakMax={peakMax} />
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Intensity scales with order count per day/hour in the tenant&apos;s local timezone.
        </p>
      </Card>
    </>
  );
}

function DayRow({
  dow, dayLabel, peakMap, peakMax,
}: {
  dow: number; dayLabel: string; peakMap: Map<string, number>; peakMax: number;
}) {
  return (
    <>
      <div className="text-xs text-muted-foreground pr-2 flex items-center">{dayLabel}</div>
      {Array.from({ length: 24 }, (_, h) => {
        const count = peakMap.get(`${dow}-${h}`) ?? 0;
        const intensity = peakMax > 0 ? count / peakMax : 0;
        const bg = count > 0
          ? { backgroundColor: `color-mix(in srgb, var(--color-primary) ${Math.round(intensity * 100)}%, transparent)` }
          : undefined;
        return (
          <div
            key={h}
            title={`${dayLabel} ${h}:00 — ${count} order${count === 1 ? "" : "s"}`}
            className="aspect-square rounded-sm border border-border/40"
            style={bg}
          />
        );
      })}
    </>
  );
}
