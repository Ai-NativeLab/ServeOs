// src/app/admin/tenants/page.tsx
import Link from "next/link";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { listTenants } from "@/server/platform";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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

const STATUS_VARIANT: Record<
  string,
  React.ComponentProps<typeof Badge>["variant"]
> = {
  active: "default",
  trial: "secondary",
  onboarding: "outline",
  suspended: "destructive",
  rejected: "destructive",
};

export default async function TenantsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  await requireSuperAdmin();
  const { status, q, page: pageParam } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);

  const { rows, total } = await listTenants({
    status: status && status !== "all" ? status : undefined,
    search: q || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const buildHref = (p: number) => {
    const params = new URLSearchParams();
    if (status && status !== "all") params.set("status", status);
    if (q) params.set("q", q);
    params.set("page", String(p));
    return `/admin/tenants?${params.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Tenants"
        eyebrow="Platform"
        description="All stores on the platform"
      />
      <Card>
        <CardContent className="py-4 flex flex-wrap items-center gap-3">
          <form
            method="get"
            className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3 w-full"
          >
            <Input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search name or slug"
              className="w-full sm:w-64"
            />
            <select
              name="status"
              defaultValue={status ?? "all"}
              className="h-9 w-full sm:w-auto rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="trial">Trial</option>
              <option value="onboarding">Onboarding</option>
              <option value="suspended">Suspended</option>
              <option value="rejected">Rejected</option>
            </select>
            <button
              type="submit"
              className="text-sm px-3 py-2 rounded-md bg-primary text-primary-foreground w-full sm:w-auto"
            >
              Filter
            </button>
          </form>
        </CardContent>
      </Card>
      <Card className="mt-3">
        <CardContent className="pt-4">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Vertical</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>{t.slug}</TableCell>
                    <TableCell className="capitalize">{t.vertical}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[t.status] ?? "outline"}>
                        {t.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{t.planName ?? "—"}</TableCell>
                    <TableCell>
                      {t.createdAt.toISOString().slice(0, 10)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/admin/tenants/${t.id}`}
                        className="text-sm text-primary hover:underline"
                      >
                        View
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center text-muted-foreground py-6"
                    >
                      No tenants found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
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
