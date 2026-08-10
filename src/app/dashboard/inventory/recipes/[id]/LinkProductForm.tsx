"use client";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Label } from "@/components/ui/label";
import { linkProductAction } from "../../actions";

const selectCls = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

/**
 * Points a dish at this recipe. Re-linking replaces any previous link for the
 * same product, so a sellable can only ever resolve to one thing.
 */
export function LinkProductForm({ recipeId, products, currentProductId }: {
  recipeId: string; products: { id: string; nameEn: string }[]; currentProductId: string | null;
}) {
  if (products.length === 0) {
    return <p className="text-sm text-muted-foreground">Create a product on the menu first, then link it here.</p>;
  }
  return (
    <ToastForm action={linkProductAction} successMessage="Dish linked" className="space-y-3">
      <input type="hidden" name="recipeId" value={recipeId} />
      <div className="space-y-1.5">
        <Label htmlFor={`product-${recipeId}`}>{currentProductId ? "Change dish" : "Link a dish"}</Label>
        <select
          id={`product-${recipeId}`} name="productId" className={selectCls}
          defaultValue={currentProductId ?? products[0].id}
        >
          {products.map((p) => <option key={p.id} value={p.id}>{p.nameEn}</option>)}
        </select>
      </div>
      <SubmitButton size="sm" className="w-full">{currentProductId ? "Re-link" : "Link dish"}</SubmitButton>
    </ToastForm>
  );
}
