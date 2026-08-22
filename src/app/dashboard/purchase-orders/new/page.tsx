import Link from "next/link";
import { requirePurchasingPermission } from "../../purchasing-permission";
import { listSuppliers } from "@/server/purchasing/suppliers";
import { listItems } from "@/server/inventory/read";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/button";
import { DraftPoForm } from "./DraftPoForm";

export default async function NewPurchaseOrderPage() {
  const ctx = await requirePurchasingPermission("purchasing:manage");

  const [suppliers, items] = await Promise.all([
    listSuppliers(ctx.tenantId),
    listItems(ctx.tenantId, { isActive: true, limit: 200 }),
  ]);

  const formSuppliers = suppliers.map((s) => ({
    id: s.id,
    name: s.name,
    isActive: s.isActive,
  }));

  const formItems = items.map((it) => ({
    id: it.id,
    nameEn: it.nameEn,
    baseUom: it.baseUom,
    sku: it.sku,
  }));

  return (
    <>
      <PageHeader
        eyebrow="Purchasing"
        title="Draft purchase order"
        description="Select a supplier and add inventory line items to replenish your branch stock."
        action={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/purchase-orders">Cancel</Link>
          </Button>
        }
      />

      <div className="max-w-4xl">
        <DraftPoForm suppliers={formSuppliers} items={formItems} />
      </div>
    </>
  );
}
