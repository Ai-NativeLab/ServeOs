import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getBranch } from "@/server/branches/service";
import { updateBranchAction, deleteBranchAction } from "../actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function EditBranchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const branch = await getBranch(ctx.tenantId, id);

  return (
    <>
      <Link href="/dashboard/branches" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Branches
      </Link>
      <PageHeader eyebrow="Locations" title={branch.name} />

      <Card className="p-5 max-w-2xl mb-6">
        <form action={updateBranchAction.bind(null, id)} className="grid gap-4">
          <div className="grid md:grid-cols-3 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue={branch.name} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="address">Address</Label>
              <Input id="address" name="address" defaultValue={branch.address ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" defaultValue={branch.phone ?? ""} />
            </div>
          </div>
          <div><SubmitButton>Save changes</SubmitButton></div>
        </form>
      </Card>

      <ConfirmActionButton
        action={deleteBranchAction.bind(null, id)}
        label="Deactivate branch"
        title={`Deactivate "${branch.name}"?`}
        description="The branch will stop appearing on your storefront and can no longer take orders."
        successMessage="Branch deactivated"
      />
    </>
  );
}
