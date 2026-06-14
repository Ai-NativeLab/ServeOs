import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getBranch } from "@/server/branches/service";
import { updateBranchAction, deleteBranchAction } from "../actions";

export default async function EditBranchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const branch = await getBranch(ctx.tenantId, id);

  const updateAction = updateBranchAction.bind(null, id);
  const deleteAction = deleteBranchAction.bind(null, id);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Edit Branch</h1>
      <form action={updateAction}>
        <input name="name" defaultValue={branch.name} required />
        <input name="address" defaultValue={branch.address ?? ""} />
        <input name="phone" defaultValue={branch.phone ?? ""} />
        <button type="submit">Save</button>
      </form>
      <form action={deleteAction} style={{ marginTop: 16 }}>
        <button type="submit" style={{ color: "red" }}>Deactivate Branch</button>
      </form>
      <p><a href="/dashboard/branches">← Back</a></p>
    </main>
  );
}
