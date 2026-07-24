// src/app/admin/billing/page.tsx
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { listInvoicesPendingVerification } from "@/server/billing/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { confirmInvoiceAction, rejectInvoiceAction } from "./actions";

export default async function BillingPage() {
  await requireSuperAdmin();
  const pending = await listInvoicesPendingVerification();

  return (
    <>
      <PageHeader title="Billing" eyebrow="Platform" description="Subscription invoices awaiting payment verification" />
      <Card>
        <CardContent className="pt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tenant</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Proof</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-medium">{inv.tenantName}</TableCell>
                  <TableCell className="font-mono">{Number(inv.amount).toFixed(2)} {inv.currency}</TableCell>
                  <TableCell>{inv.reference ?? "—"}</TableCell>
                  <TableCell>
                    {inv.proofUrl ? (
                      <a href={inv.proofUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        View
                      </a>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>{inv.createdAt.toISOString().slice(0, 10)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <form action={confirmInvoiceAction.bind(null, inv.id, inv.tenantId)}>
                        <SubmitButton size="sm">Confirm</SubmitButton>
                      </form>
                      <form action={rejectInvoiceAction.bind(null, inv.id, inv.tenantId)}>
                        <SubmitButton size="sm" variant="outline">Reject</SubmitButton>
                      </form>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {pending.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                    No invoices pending verification.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
