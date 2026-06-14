import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories } from "@/server/catalog/service";
import { createProductAction } from "../actions";

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ categoryId?: string }> }) {
  const { categoryId } = await searchParams;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>New Product</h1>
      <form action={createProductAction}>
        <div>
          <label>Category:
            <select name="categoryId" defaultValue={categoryId ?? ""} required>
              <option value="">Select…</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.nameEn}</option>)}
            </select>
          </label>
        </div>
        <div><label>Name (EN): <input name="nameEn" required /></label></div>
        <div><label>Name (AR): <input name="nameAr" required dir="rtl" /></label></div>
        <div><label>Description (EN): <input name="descriptionEn" /></label></div>
        <div><label>Description (AR): <input name="descriptionAr" dir="rtl" /></label></div>
        <div><label>Base Price: <input name="basePrice" type="number" step="0.01" required /></label></div>
        <button type="submit">Create</button>
      </form>
      <p><a href="/dashboard/menu">← Back</a></p>
    </main>
  );
}
