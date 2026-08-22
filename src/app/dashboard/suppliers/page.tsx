import { requirePurchasingPermission } from "../purchasing-permission";
import { listSuppliers } from "@/server/purchasing/suppliers";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupplierAction } from "./actions";

export default async function SuppliersPage() {
  const ctx = await requirePurchasingPermission("suppliers:manage");
  const suppliers = await listSuppliers(ctx.tenantId);

  return (
    <>
      <PageHeader
        eyebrow="Purchasing"
        title="Suppliers"
        description="The vendors you buy stock from. Email lets a PO be sent straight to them."
      />

      <Card className="mb-6 p-4">
        <ToastForm action={createSupplierAction} successMessage="Supplier added" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="grid gap-1.5">
            <Label htmlFor="s-name">Name</Label>
            <Input id="s-name" name="name" required placeholder="Acme Foods" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="s-contact">Contact</Label>
            <Input id="s-contact" name="contactName" placeholder="Ahmed Ali" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="s-email">Email</Label>
            <Input id="s-email" name="email" type="email" placeholder="supplier@acme.example" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="s-phone">Phone</Label>
            <Input id="s-phone" name="phone" placeholder="+20 …" />
          </div>
          <div className="flex items-end">
            <SubmitButton className="w-full">Add supplier</SubmitButton>
          </div>
        </ToastForm>
      </Card>

      {suppliers.length === 0 ? (
        <EmptyState
          title="No suppliers yet"
          description="Add your first supplier above — purchase orders are always addressed to one."
        />
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="eyebrow">Name</TableHead>
                <TableHead className="eyebrow">Contact</TableHead>
                <TableHead className="eyebrow">Email</TableHead>
                <TableHead className="eyebrow">Phone</TableHead>
                <TableHead className="eyebrow">Terms</TableHead>
                <TableHead className="eyebrow">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <a
                      href={`/dashboard/suppliers/${s.id}`}
                      className="text-primary underline-offset-4 hover:underline font-semibold"
                    >
                      {s.name}
                    </a>
                  </TableCell>
                  <TableCell>{s.contactName ?? "—"}</TableCell>
                  <TableCell>{s.email ?? "—"}</TableCell>
                  <TableCell>{s.phone ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{s.paymentTerms ?? "—"}</TableCell>
                  <TableCell>
                    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${s.isActive ? "bg-green-500/10 text-green-700" : "bg-muted text-muted-foreground"}`}>
                      {s.isActive ? "Active" : "Inactive"}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
