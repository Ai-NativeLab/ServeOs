// src/app/admin/approvals/page.tsx
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { listPendingApplications } from "@/server/platform";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { approveAction, rejectAction } from "./actions";

export default async function ApprovalsPage() {
  await requireSuperAdmin();
  const pending = await listPendingApplications();

  return (
    <>
      <PageHeader title="Approvals" eyebrow="Platform" description="Pending store applications" />
      <Card>
        <CardContent className="pt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Store</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Vertical</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.map((p) => (
                <TableRow key={p.applicationId}>
                  <TableCell className="font-medium">{p.tenantName}</TableCell>
                  <TableCell>{p.slug}</TableCell>
                  <TableCell><span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">{p.vertical}</span></TableCell>
                  <TableCell>{p.submittedAt ? p.submittedAt.toISOString().slice(0, 10) : "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <form action={approveAction}>
                        <input type="hidden" name="tenantId" value={p.tenantId} />
                        <SubmitButton size="sm">Approve</SubmitButton>
                      </form>
                      <form action={rejectAction}>
                        <input type="hidden" name="tenantId" value={p.tenantId} />
                        <input name="notes" placeholder="Reason" className="h-8 rounded-md border border-input px-2 text-sm" />
                        <SubmitButton size="sm" variant="outline">Reject</SubmitButton>
                      </form>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {pending.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">No pending applications.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
