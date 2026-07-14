import { redirect } from "next/navigation";
import { listPendingApplications } from "@/server/platform";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { approveAction, rejectAction } from "./actions";

export default async function AdminQueue() {
  try {
    await requireSuperAdmin();
  } catch {
    redirect("/admin/login");
  }
  const pending = await listPendingApplications();
  return (
    <main style={{ padding: 48, fontFamily: "system-ui" }}>
      <h1>Pending applications</h1>
      {pending.length === 0 && <p>No pending applications.</p>}
      <ul style={{ display: "grid", gap: 16, listStyle: "none", padding: 0 }}>
        {pending.map((p) => (
          <li key={p.applicationId} style={{ border: "1px solid #ddd", padding: 16 }}>
            <strong>{p.tenantName}</strong> — {p.slug}.serveos.com
            <span style={{ marginLeft: 8, padding: "2px 8px", background: "#eef", borderRadius: 999, fontSize: 12 }}>{p.vertical}</span>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <form action={approveAction}>
                <input type="hidden" name="tenantId" value={p.tenantId} />
                <button type="submit">Approve</button>
              </form>
              <form action={rejectAction}>
                <input type="hidden" name="tenantId" value={p.tenantId} />
                <input name="notes" placeholder="Reason" />
                <button type="submit">Reject</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
