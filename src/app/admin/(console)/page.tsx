// src/app/admin/page.tsx
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { listPendingApplications } from "@/server/platform";
import { auditLogs } from "@/server/platform/audit.schema";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import {
  getPlatformSignups, getTenantsByStatus, getPlatformMrr, getPlatformMrrTrend, getTrialsEndingSoon,
} from "@/server/analytics/platform";
import { SignupChart, MrrChart, StatusChart } from "@/components/admin/charts";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-3xl font-bold tabular-nums text-ink">{value}</div>
        <div className="text-xs text-muted-foreground mt-1">{label}</div>
      </CardContent>
    </Card>
  );
}

export default async function AdminOverview() {
  await requireSuperAdmin();
  const [byStatus, signups, mrr, mrrTrend, trialsSoon, pending, recent] = await Promise.all([
    getTenantsByStatus(),
    getPlatformSignups(30),
    getPlatformMrr(),
    getPlatformMrrTrend(30),
    getTrialsEndingSoon(7),
    listPendingApplications(),
    db.select({
      id: auditLogs.id, action: auditLogs.action, createdAt: auditLogs.createdAt,
      tenantName: tenants.name, actor: users.name,
    })
      .from(auditLogs)
      .leftJoin(tenants, eq(auditLogs.tenantId, tenants.id))
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(8),
  ]);

  const total = byStatus.reduce((s, r) => s + r.count, 0);

  return (
    <>
      <PageHeader title="Overview" eyebrow="Platform" description="Fleet health at a glance" />
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <Stat label="Total tenants" value={total} />
        <Stat label="Active" value={byStatus.find((r) => r.status === "active")?.count ?? 0} />
        <Stat label="Trials" value={byStatus.find((r) => r.status === "trial")?.count ?? 0} />
        <Stat label="Suspended" value={byStatus.find((r) => r.status === "suspended")?.count ?? 0} />
        <Stat label="Pending" value={pending.length} />
        <Stat label="MRR" value={`${mrr.toLocaleString()}`} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-6">
        <SignupChart data={signups} />
        <MrrChart data={mrrTrend} />
        <StatusChart data={byStatus} />
      </div>
      <Card>
        <CardHeader><CardTitle>Recent activity</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {recent.length === 0 && <p className="text-muted-foreground">No activity yet.</p>}
          {recent.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3">
              <span><Badge variant="outline">{r.action}</Badge> <span className="text-muted-foreground">{r.tenantName ?? "—"}</span></span>
              <span className="text-xs text-muted-foreground">{r.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
            </div>
          ))}
          {trialsSoon > 0 && (
            <p className="text-xs text-muted-foreground pt-2">{trialsSoon} trial(s) ending in the next 7 days.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
