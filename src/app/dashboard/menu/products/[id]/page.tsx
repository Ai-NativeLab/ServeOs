import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getProduct } from "@/server/catalog/service";
import {
  updateProductAction,
  deleteProductAction,
  upsertModifierGroupAction,
  deleteModifierGroupAction,
  upsertModifierOptionAction,
  deleteModifierOptionAction,
} from "../actions";

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const product = await getProduct(ctx.tenantId, id);

  const updateAction = updateProductAction.bind(null, id);
  const deleteAction = deleteProductAction.bind(null, id);
  const addGroupAction = upsertModifierGroupAction.bind(null, id);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Edit Product: {product.nameEn}</h1>

      <form action={updateAction}>
        <div><label>Name (EN): <input name="nameEn" defaultValue={product.nameEn} required /></label></div>
        <div><label>Name (AR): <input name="nameAr" defaultValue={product.nameAr} required dir="rtl" /></label></div>
        <div><label>Description (EN): <input name="descriptionEn" defaultValue={product.descriptionEn ?? ""} /></label></div>
        <div><label>Description (AR): <input name="descriptionAr" defaultValue={product.descriptionAr ?? ""} dir="rtl" /></label></div>
        <div><label>Base Price: <input name="basePrice" type="number" step="0.01" defaultValue={String(product.basePrice)} required /></label></div>
        <div>
          <label>
            <input type="checkbox" name="isPublished" value="true" defaultChecked={product.isPublished} />
            {" "}Published
          </label>
        </div>
        <button type="submit">Save</button>
      </form>

      <h2>Modifier Groups</h2>
      {product.modifierGroups.map((group) => {
        const delGroup = deleteModifierGroupAction.bind(null, id, group.id);
        const addOpt = upsertModifierOptionAction.bind(null, id, group.id);
        return (
          <section key={group.id} style={{ border: "1px solid #ccc", padding: 12, marginBottom: 12 }}>
            <strong>{group.nameEn} / {group.nameAr}</strong>
            {" "}(min: {group.minSelections}, max: {group.maxSelections}, required: {String(group.required)})
            <form action={delGroup} style={{ display: "inline" }}>
              <button type="submit" style={{ color: "red", marginLeft: 8 }}>[delete group]</button>
            </form>
            <ul>
              {group.options.map((opt) => {
                const delOpt = deleteModifierOptionAction.bind(null, id, opt.id);
                return (
                  <li key={opt.id}>
                    {opt.nameEn} / {opt.nameAr} (+{opt.priceDelta})
                    <form action={delOpt} style={{ display: "inline" }}>
                      <button type="submit" style={{ color: "red", marginLeft: 4 }}>[x]</button>
                    </form>
                  </li>
                );
              })}
            </ul>
            <form action={addOpt}>
              <input name="nameEn" placeholder="Option EN" required />
              <input name="nameAr" placeholder="Option AR" dir="rtl" required />
              <input name="priceDelta" type="number" step="0.01" placeholder="Price delta" defaultValue="0" />
              <button type="submit">Add Option</button>
            </form>
          </section>
        );
      })}

      <h3>Add Modifier Group</h3>
      <form action={addGroupAction}>
        <input name="nameEn" placeholder="Group name EN" required />
        <input name="nameAr" placeholder="Group name AR" dir="rtl" required />
        <label><input type="checkbox" name="required" value="true" /> Required</label>
        <input name="minSelections" type="number" defaultValue="0" min="0" placeholder="Min" />
        <input name="maxSelections" type="number" defaultValue="1" min="1" placeholder="Max" />
        <button type="submit">Add Group</button>
      </form>

      <form action={deleteAction} style={{ marginTop: 24 }}>
        <button type="submit" style={{ color: "red" }}>Delete Product</button>
      </form>
      <p><a href="/dashboard/menu">← Back</a></p>
    </main>
  );
}
