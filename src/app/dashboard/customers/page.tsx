import { requireCustomersPermission } from "../customers-permission";
import { getCapabilities, selectStorefrontTemplate, type VerticalId } from "@/server/verticals";
import { getTenantById } from "@/server/tenancy";
import { listCustomers } from "@/server/customers/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { TradeApprovalForm } from "./TradeApprovalForm";

export default async function CustomersPage() {
  const ctx = await requireCustomersPermission();
  const [tenant, customers] = await Promise.all([
    getTenantById(ctx.tenantId),
    listCustomers(ctx.tenantId),
  ]);
  const caps = getCapabilities(selectStorefrontTemplate(tenant?.vertical as VerticalId));

  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Customers"
        description="Everyone who has created an account on your storefront."
      />
      {customers.length === 0 ? (
        <EmptyState
          title="No accounts yet"
          description="Customers who sign up on your storefront will appear here."
        />
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="eyebrow">Name</TableHead>
                <TableHead className="eyebrow">Email</TableHead>
                <TableHead className="eyebrow">Phone</TableHead>
                <TableHead className="eyebrow">Joined</TableHead>
                {caps.tradeAccounts && <TableHead className="eyebrow">Trade account</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.email}</TableCell>
                  <TableCell>{c.phone ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{c.createdAt.toLocaleDateString()}</TableCell>
                  {caps.tradeAccounts && (
                    <TableCell>
                      <TradeApprovalForm
                        customerId={c.id}
                        tradeApproved={c.tradeApproved}
                        tradeDiscountPercent={c.tradeDiscountPercent}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
