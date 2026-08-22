import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requirePurchasingPermission } from "../../purchasing-permission";
import { getSupplier, listSupplierItems } from "@/server/purchasing/suppliers";
import { listItems } from "@/server/inventory/read";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EditSupplierForm } from "./EditSupplierForm";
import { SupplierItemCatalog } from "./SupplierItemCatalog";

export default async function SupplierDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePurchasingPermission("suppliers:manage");

  const [supplier, supplierItems, items] = await Promise.all([
    getSupplier(ctx.tenantId, id),
    listSupplierItems(ctx.tenantId, id),
    listItems(ctx.tenantId, { isActive: true, limit: 200 }),
  ]);

  if (!supplier) {
    notFound();
  }

  const availableItems = items.map((it) => ({
    id: it.id,
    nameEn: it.nameEn,
    baseUom: it.baseUom,
    sku: it.sku,
  }));

  return (
    <div className="space-y-6 max-w-5xl pb-12">
      <Link
        href="/dashboard/suppliers"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to suppliers
      </Link>

      <PageHeader
        eyebrow="Supplier"
        title={supplier.name}
        description="Manage vendor contact info, payment terms, and mapped item catalogs."
        action={
          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
              supplier.isActive
                ? "bg-green-500/10 text-green-700"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {supplier.isActive ? "Active" : "Inactive"}
          </span>
        }
      />

      <EditSupplierForm supplier={supplier} />

      <SupplierItemCatalog
        supplierId={supplier.id}
        supplierItems={supplierItems}
        availableItems={availableItems}
      />
    </div>
  );
}
