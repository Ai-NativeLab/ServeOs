// src/app/admin/audit/page.tsx
import { requireSuperAdmin } from "@/server/auth/admin-context";
import {
  listAuditLogs,
  listDistinctAuditActions,
  listTenantOptions,
} from "@/server/platform";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Pagination } from "@/components/admin/Pagination";

const PAGE_SIZE = 25;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    action?: string;
    tenant?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  await requireSuperAdmin();
  const {
    action,
    tenant,
    from: fromParam,
    to: toParam,
    page: pageParam,
  } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);

  const from = fromParam ? new Date(`${fromParam}T00:00:00.000Z`) : undefined;
  const to = toParam ? new Date(`${toParam}T23:59:59.999Z`) : undefined;

  const [actions, tenantOptions, { rows, total }] = await Promise.all([
    listDistinctAuditActions(),
    listTenantOptions(),
    listAuditLogs({
      action: action || undefined,
      tenantId: tenant || undefined,
      from,
      to,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  ]);

  const buildHref = (p: number) => {
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (tenant) params.set("tenant", tenant);
    if (fromParam) params.set("from", fromParam);
    if (toParam) params.set("to", toParam);
    params.set("page", String(p));
    return `/admin/audit?${params.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        eyebrow="Platform"
        description="All platform actions"
      />
      <div className="@container">
        <form
          method="get"
          className="mb-4 grid grid-cols-1 @[420px]:grid-cols-2 @2xl:flex @2xl:flex-wrap @2xl:items-end gap-3 text-sm"
        >
          <div>
            <label
              className="mb-1 block text-muted-foreground"
              htmlFor="action"
            >
              Action
            </label>
            <select
              id="action"
              name="action"
              defaultValue={action ?? ""}
              className="h-9 w-full @2xl:w-auto rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">All actions</option>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              className="mb-1 block text-muted-foreground"
              htmlFor="tenant"
            >
              Tenant
            </label>
            <select
              id="tenant"
              name="tenant"
              defaultValue={tenant ?? ""}
              className="h-9 w-full @2xl:w-auto rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">All tenants</option>
              {tenantOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.slug})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-muted-foreground" htmlFor="from">
              From
            </label>
            <input
              id="from"
              name="from"
              type="date"
              defaultValue={fromParam ?? ""}
              className="h-9 w-full @2xl:w-auto rounded-md border border-input bg-background px-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-muted-foreground" htmlFor="to">
              To
            </label>
            <input
              id="to"
              name="to"
              type="date"
              defaultValue={toParam ?? ""}
              className="h-9 w-full @2xl:w-auto rounded-md border border-input bg-background px-2 text-sm"
            />
          </div>
          <button
            type="submit"
            className="col-span-1 @[420px]:col-span-2 @2xl:col-auto text-sm px-3 py-2 rounded-md bg-primary text-primary-foreground w-full @2xl:w-auto"
          >
            Filter
          </button>
        </form>
      </div>
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
                  <TableCell>
                    {a.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{a.action}</Badge>
                  </TableCell>
                  <TableCell>{a.tenantName ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {a.target ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-muted-foreground py-6"
                  >
                    No events.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            buildHref={buildHref}
          />
        </CardContent>
      </Card>
    </>
  );
}
