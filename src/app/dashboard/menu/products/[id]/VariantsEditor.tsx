import { Plus } from "lucide-react";
import type { ProductVariant } from "@/server/catalog";
import { upsertVariantAction, deleteVariantAction } from "../actions";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function VariantsEditor({ productId, variants }: { productId: string; variants: ProductVariant[] }) {
  return (
    <>
      <h2 className="eyebrow text-primary mb-3">Variants</h2>
      <div className="space-y-4 max-w-2xl mb-6">
        <Card className="p-5">
          {variants.length === 0 && (
            <p className="text-sm text-muted-foreground mb-3">No variants yet — the product sells at its base price. Add variants (size, color, pack) each with its own price and stock.</p>
          )}
          <ul className="text-sm divide-y">
            {variants.map((v) => (
              <li key={v.id} className="py-2 flex items-center justify-between gap-2">
                <span>
                  {v.nameEn} <span className="text-muted-foreground" dir="rtl">/ {v.nameAr}</span>
                  {v.sku && <span className="ml-2 font-mono text-xs text-muted-foreground">{v.sku}</span>}
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-mono text-xs">{Number(v.price).toFixed(2)}</span>
                  <span className="text-xs text-muted-foreground">{v.stockQuantity === null ? "untracked" : `${v.stockQuantity} in stock`}</span>
                  <ToastForm action={deleteVariantAction.bind(null, productId, v.id)} successMessage="Variant removed">
                    <SubmitButton variant="ghost" size="sm" className="text-destructive hover:text-destructive">Remove</SubmitButton>
                  </ToastForm>
                </span>
              </li>
            ))}
          </ul>
          <ToastForm action={upsertVariantAction.bind(null, productId)} successMessage="Variant saved" className="flex flex-wrap items-end gap-2 mt-3">
            <Input name="nameEn" placeholder="Variant (EN)" required className="w-36" />
            <Input name="nameAr" placeholder="Variant (AR)" dir="rtl" required className="w-36" />
            <Input name="sku" placeholder="SKU" className="w-28" />
            <Input name="price" type="number" step="0.01" min="0" placeholder="Price" required className="w-24" />
            <Input name="stockQuantity" type="number" min="0" placeholder="Stock" className="w-24" />
            <SubmitButton variant="outline" size="sm"><Plus className="size-4" />Add variant</SubmitButton>
          </ToastForm>
        </Card>
      </div>
    </>
  );
}
