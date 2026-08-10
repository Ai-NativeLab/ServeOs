import Link from "next/link";
import { requireInventoryPermission } from "../../../inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { createItemAction } from "../../actions";

const selectCls = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

export default async function NewInventoryItemPage() {
  try {
    await requireInventoryPermission("inventory:manage");
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return (
        <>
          <PageHeader eyebrow="Inventory" title="New item" />
          <EmptyState title="Not authorized" description="Creating stock items needs the inventory:manage permission." />
        </>
      );
    }
    throw e;
  }

  return (
    <>
      <PageHeader
        eyebrow="Inventory"
        title="New item"
        description="A stockable thing you hold — an ingredient, a finished good, or a raw material. It is separate from the product you sell; you link the two afterwards."
        action={<Button asChild variant="ghost" size="sm"><Link href="/dashboard/inventory">Cancel</Link></Button>}
      />

      <Card className="p-6 max-w-2xl">
        <ToastForm action={createItemAction} successMessage="Item created" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nameEn">Name</Label>
              <Input id="nameEn" name="nameEn" required autoFocus placeholder="Mozzarella" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nameAr">Name (Arabic)</Label>
              <Input id="nameAr" name="nameAr" dir="rtl" placeholder="موزاريلا" />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="kind">Kind</Label>
              <select id="kind" name="kind" className={selectCls} defaultValue="ingredient">
                <option value="ingredient">Ingredient — consumed by a recipe</option>
                <option value="finished_good">Finished good — sold as-is</option>
                <option value="raw_material">Raw material</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="baseUom">Base unit</Label>
              {/* Every ledger row and lot is stored normalized to this, which is
                  why it cannot be changed later — it would reinterpret history. */}
              <select id="baseUom" name="baseUom" className={selectCls} defaultValue="each">
                <option value="each">each — countable</option>
                <option value="g">grams</option>
                <option value="kg">kilograms</option>
                <option value="ml">millilitres</option>
                <option value="l">litres</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Fixed once set — all stock is recorded in this unit.
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sku">SKU</Label>
              <Input id="sku" name="sku" placeholder="Optional internal code" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="isPerishable">Perishable</Label>
              <select id="isPerishable" name="isPerishable" className={selectCls} defaultValue="false">
                <option value="false">No</option>
                <option value="true">Yes — consume soonest-expiry first</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Expired lots are never sold; they stay on hand until written off.
              </p>
            </div>
          </div>

          <SubmitButton>Create item</SubmitButton>
        </ToastForm>
      </Card>
    </>
  );
}
