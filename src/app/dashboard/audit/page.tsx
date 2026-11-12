import { requireAuditPermission } from "../audit-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { listAuditEvents, getChainStatus } from "@/server/audit/read";
import { listClockSkewFlaggedReceipts } from "@/server/pos/sync-receipt";
import { getTenantById } from "@/server/tenancy";
import { formatDayTime } from "@/lib/datetime";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

const ACTOR_TYPES = ["", "user", "system", "device", "customer"] as const;
const inputCls = "rounded-md border bg-background px-3 py-1.5 text-sm";

import { PermissionDenied } from "@/components/dashboard/PermissionDenied";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; entityType?: string; actorType?: string }>;
}) {
  let ctx;
  try {
    ctx = await requireAuditPermission();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return (
        <>
          <PageHeader eyebrow="Audit" title="Audit log" />
          <PermissionDenied permission="audit:view" />
        </>
      );
    }
    throw e; // requireDashboardUser redirects unauthenticated users
  }

  const { action, entityType, actorType } = await searchParams;
  const [events, status, tenant, skewed] = await Promise.all([
    listAuditEvents(ctx.tenantId, { action: action || undefined, entityType: entityType || undefined, actorType: actorType || undefined }),
    getChainStatus(ctx.tenantId),
    getTenantById(ctx.tenantId),
    listClockSkewFlaggedReceipts(ctx.tenantId),
  ]);
  const tz = tenant?.timezone ?? "UTC";

  const chainOk = status.verification.ok;
  const banner = chainOk
    ? { cls: "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400", text: `Chain OK — ${status.head?.seq ?? 0} events` }
    : { cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400", text: `Tamper detected at seq ${(status.verification as { brokenSeq: number }).brokenSeq}` };

  return (
    <>
      <PageHeader
        eyebrow="Audit"
        title="Audit log"
        description="Append-only, hash-chained record of every mutating action, auth event, and sensitive read."
      />

      <div className={`rounded-lg border px-4 py-3 text-sm font-medium mb-4 ${banner.cls}`}>
        {chainOk ? "✓ " : "⚠ "}{banner.text}
      </div>

      {skewed.length > 0 && (
        <div className="rounded-lg border px-4 py-3 text-sm mb-4 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
          <p className="font-medium">
            ⚠ {skewed.length} clock-skew-flagged sync event{skewed.length === 1 ? "" : "s"} — the till&apos;s clock was more than 48h off the server&apos;s when received.
          </p>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {skewed.map((r) => (
              <li key={r.eventId}>
                {r.deviceLabel} · {r.type} · till said {formatDayTime(r.occurredAt, tz)}, server received it {formatDayTime(r.receivedAt, tz)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <form method="GET" className="flex flex-wrap items-center gap-2 mb-4">
        <input name="action" defaultValue={action ?? ""} placeholder="action" className={inputCls} />
        <input name="entityType" defaultValue={entityType ?? ""} placeholder="entity type" className={inputCls} />
        <select name="actorType" defaultValue={actorType ?? ""} className={inputCls}>
          {ACTOR_TYPES.map((a) => (
            <option key={a} value={a}>{a === "" ? "any actor" : a}</option>
          ))}
        </select>
        <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">Filter</button>
      </form>

      {events.length === 0 ? (
        <EmptyState title="No events" description="Nothing matches these filters yet." />
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>Device / IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => {
                const fp = e.fingerprint as { appVersion?: string | null; ip?: string | null };
                return (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDayTime(e.createdAt, tz)}</TableCell>
                    <TableCell className="font-mono text-xs">{e.action}</TableCell>
                    <TableCell className="text-xs">{e.entityType}<span className="text-muted-foreground">/{e.entityId.slice(0, 8)}</span></TableCell>
                    <TableCell className="text-xs">{e.actorType}</TableCell>
                    <TableCell className="text-sm">{e.summary}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{[fp?.appVersion, fp?.ip].filter(Boolean).join(" · ") || "—"}</TableCell>
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
