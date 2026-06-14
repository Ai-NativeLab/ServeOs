import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listBranches } from "@/server/branches/service";
import { createBranchAction } from "./actions";

export default async function BranchesPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const branches = await listBranches(ctx.tenantId);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Branches</h1>
      <ul>
        {branches.map((b) => (
          <li key={b.id}>
            <a href={`/dashboard/branches/${b.id}`}>{b.name}</a>
            {b.address && <span> — {b.address}</span>}
          </li>
        ))}
      </ul>
      <h2>Add Branch</h2>
      <form action={createBranchAction}>
        <input name="name" placeholder="Branch name" required />
        <input name="address" placeholder="Address (optional)" />
        <input name="phone" placeholder="Phone (optional)" />
        <button type="submit">Create</button>
      </form>
    </main>
  );
}
