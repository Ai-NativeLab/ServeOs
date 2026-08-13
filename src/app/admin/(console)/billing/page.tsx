import { requireSuperAdminOrRedirect } from "@/server/auth/admin-context";
import { listInvoicesNeedingAction } from "@/server/billing/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { isHttpUrl } from "@/lib/safe-url";
import { confirmInvoiceAction, rejectInvoiceAction } from "./actions";

export default async function BillingPage() {
  await requireSuperAdminOrRedirect();
  const rows = await listInvoicesNeedingAction();

  return (
    <>
      <PageHeader
        title="Billing"
        eyebrow="Platform"
        description="Plan requests waiting for a call, and payments waiting to be checked"
      />
      <Card>
        <CardContent className="pt-2 sm:pt-4">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Proof</TableHead>
                  <TableHead>Raised</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((inv) => {
                  // `open` is a lead: the tenant asked for the plan and nobody
                  // has spoken to them yet. `pending_verification` is a claim:
                  // they say they have paid. Confirm means the same thing in
                  // both cases — activate the plan — but the work before
                  // clicking it is different, so the row says which it is.
                  const isRequest = inv.status === "open";
                  return (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium">{inv.tenantName}</TableCell>
                      <TableCell>{inv.planName ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={isRequest ? "default" : "outline"}>
                          {isRequest ? "Call them" : "Check payment"}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono">
                        {Number(inv.amount).toFixed(2)} {inv.currency}
                      </TableCell>
                      <TableCell>{inv.reference ?? "—"}</TableCell>
                      <TableCell>
                        {isHttpUrl(inv.proofUrl) ? (
                          <a
                            href={inv.proofUrl!}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                          >
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
                            <SubmitButton size="sm">
                              {isRequest ? "Mark paid & activate" : "Confirm"}
                            </SubmitButton>
                          </form>
                          <form action={rejectInvoiceAction.bind(null, inv.id, inv.tenantId)}>
                            <SubmitButton size="sm" variant="outline">
                              {isRequest ? "Drop" : "Reject"}
                            </SubmitButton>
                          </form>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                      Nothing waiting.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
