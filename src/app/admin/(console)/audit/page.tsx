// src/app/admin/audit/page.tsx
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { listAuditLogs } from "@/server/platform";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  await requireSuperAdmin();
  const { action } = await searchParams;
  const rows = await listAuditLogs({ action: action || undefined, limit: 100 });
  const actions = Array.from(new Set(rows.map((r) => r.action))).sort();

  return (
    <>
      <PageHeader title="Audit log" eyebrow="Platform" description="All platform actions" />
      <form method="get" className="mb-4 flex items-center gap-2 text-sm">
        <label className="text-muted-foreground" htmlFor="action">Action</label>
        <select
          id="action"
          name="action"
          defaultValue={action ?? ""}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">All</option>
          {actions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <button type="submit" className="h-9 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted">Filter</button>
      </form>
      <Card>
        <CardContent className="pt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.createdAt.toISOString().slice(0, 16).replace("T", " ")}</TableCell>
                  <TableCell><Badge variant="outline">{a.action}</Badge></TableCell>
                  <TableCell>{a.tenantName ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{a.target ?? "—"}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-6">No events.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
