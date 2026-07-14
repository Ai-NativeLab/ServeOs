// src/app/admin/tenants/page.tsx
import Link from "next/link";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { listTenants } from "@/server/platform";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const STATUS_VARIANT: Record<string, React.ComponentProps<typeof Badge>["variant"]> = {
  active: "default", trial: "secondary", onboarding: "outline", suspended: "destructive", rejected: "destructive",
};

export default async function TenantsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  await requireSuperAdmin();
  const { status, q } = await searchParams;
  const rows = await listTenants({ status: status && status !== "all" ? status : undefined, search: q || undefined });

  return (
    <>
      <PageHeader title="Tenants" eyebrow="Platform" description="All stores on the platform" />
      <Card>
        <CardContent className="py-4 flex flex-wrap items-center gap-3">
          <form method="get" className="flex flex-wrap items-center gap-3">
            <Input name="q" defaultValue={q ?? ""} placeholder="Search name or slug" className="w-64" />
            <Select name="status" defaultValue={status ?? "all"}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="trial">Trial</SelectItem>
                <SelectItem value="onboarding">Onboarding</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            <button type="submit" className="text-sm px-3 py-2 rounded-md bg-primary text-primary-foreground">Filter</button>
          </form>
        </CardContent>
      </Card>
      <Card className="mt-3">
        <CardContent className="pt-4">
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
                  <TableCell><Badge variant={STATUS_VARIANT[t.status] ?? "outline"}>{t.status}</Badge></TableCell>
                  <TableCell>{t.planName ?? "—"}</TableCell>
                  <TableCell>{t.createdAt.toISOString().slice(0, 10)}</TableCell>
                  <TableCell className="text-right">
                    <Link href={`/admin/tenants/${t.id}`} className="text-sm text-primary hover:underline">View</Link>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">No tenants found.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
