import Link from "next/link";
import { ArrowLeft, Plus } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getProduct } from "@/server/catalog/service";
import {
  updateProductAction, deleteProductAction, upsertModifierGroupAction,
  deleteModifierGroupAction, upsertModifierOptionAction, deleteModifierOptionAction,
} from "../actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ImageInput } from "@/components/dashboard/ImageInput";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const product = await getProduct(ctx.tenantId, id);

  return (
    <>
      <Link href="/dashboard/menu" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Menu
      </Link>
      <PageHeader eyebrow="Catalog" title={product.nameEn} />

      <Card className="p-5 max-w-2xl mb-6">
        <form action={updateProductAction.bind(null, id)} className="grid gap-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="nameEn">Name (EN)</Label>
              <Input id="nameEn" name="nameEn" defaultValue={product.nameEn} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nameAr">Name (AR)</Label>
              <Input id="nameAr" name="nameAr" defaultValue={product.nameAr} required dir="rtl" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="descriptionEn">Description (EN)</Label>
              <Input id="descriptionEn" name="descriptionEn" defaultValue={product.descriptionEn ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="descriptionAr">Description (AR)</Label>
              <Input id="descriptionAr" name="descriptionAr" defaultValue={product.descriptionAr ?? ""} dir="rtl" />
            </div>
          </div>
          <div className="grid gap-1.5 max-w-48">
            <Label htmlFor="basePrice">Base price</Label>
            <Input id="basePrice" name="basePrice" type="number" step="0.01" min="0" defaultValue={String(product.basePrice)} required />
          </div>
          <div className="grid gap-1.5">
            <Label>Product image</Label>
            <ImageInput name="imageUrl" type="product" defaultValue={product.imageUrl} aspect="square" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isPublished" value="true" defaultChecked={product.isPublished} className="size-4 accent-(--color-primary)" />
            Published — visible on your storefront
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isFeatured" value="true" defaultChecked={product.isFeatured} className="size-4 accent-(--color-primary)" />
            Featured — highlighted on your storefront
          </label>
          <div><SubmitButton>Save changes</SubmitButton></div>
        </form>
      </Card>

      <h2 className="eyebrow text-primary mb-3">Modifier groups</h2>
      <div className="space-y-4 max-w-2xl mb-6">
        {product.modifierGroups.map((group) => (
          <Card key={group.id} className="p-5">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <div className="font-medium text-ink">{group.nameEn} <span className="text-muted-foreground" dir="rtl">/ {group.nameAr}</span></div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  min {group.minSelections} · max {group.maxSelections} · {group.required ? "required" : "optional"}
                </div>
              </div>
              <ConfirmActionButton
                action={deleteModifierGroupAction.bind(null, id, group.id)}
                label="Delete group"
                size="sm"
                title={`Delete "${group.nameEn}"?`}
                description="The group and all its options will be removed from this product."
                successMessage="Group deleted"
              />
            </div>
            <ul className="text-sm divide-y">
              {group.options.map((opt) => (
                <li key={opt.id} className="py-2 flex items-center justify-between gap-2">
                  <span>{opt.nameEn} <span className="text-muted-foreground" dir="rtl">/ {opt.nameAr}</span></span>
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-xs">+{Number(opt.priceDelta).toFixed(2)}</span>
                    <ToastForm action={deleteModifierOptionAction.bind(null, id, opt.id)} successMessage="Option removed">
                      <SubmitButton variant="ghost" size="sm" className="text-destructive hover:text-destructive">Remove</SubmitButton>
                    </ToastForm>
                  </span>
                </li>
              ))}
            </ul>
            <ToastForm action={upsertModifierOptionAction.bind(null, id, group.id)} successMessage="Option added" className="flex flex-wrap items-end gap-2 mt-3">
              <Input name="nameEn" placeholder="Option (EN)" required className="w-36" />
              <Input name="nameAr" placeholder="Option (AR)" dir="rtl" required className="w-36" />
              <Input name="priceDelta" type="number" step="0.01" placeholder="+ price" defaultValue="0" className="w-24" />
              <SubmitButton variant="outline" size="sm"><Plus className="size-4" />Add option</SubmitButton>
            </ToastForm>
          </Card>
        ))}

        <Card className="p-5">
          <h3 className="text-sm font-medium text-ink mb-3">Add modifier group</h3>
          <ToastForm action={upsertModifierGroupAction.bind(null, id)} successMessage="Group added" className="flex flex-wrap items-end gap-2">
            <Input name="nameEn" placeholder="Group name (EN)" required className="w-40" />
            <Input name="nameAr" placeholder="Group name (AR)" dir="rtl" required className="w-40" />
            <Input name="minSelections" type="number" defaultValue="0" min="0" className="w-20" aria-label="Min selections" />
            <Input name="maxSelections" type="number" defaultValue="1" min="1" className="w-20" aria-label="Max selections" />
            <label className="flex items-center gap-1.5 text-sm h-9">
              <input type="checkbox" name="required" value="true" className="size-4 accent-(--color-primary)" /> Required
            </label>
            <SubmitButton variant="outline" size="sm"><Plus className="size-4" />Add group</SubmitButton>
          </ToastForm>
        </Card>
      </div>

      <ConfirmActionButton
        action={deleteProductAction.bind(null, id)}
        label="Delete product"
        title={`Delete "${product.nameEn}"?`}
        description="The product and its modifiers will be removed from your menu. This can't be undone."
      />
    </>
  );
}
