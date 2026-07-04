import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories } from "@/server/catalog/service";
import { createProductAction } from "../actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ categoryId?: string }> }) {
  const { categoryId } = await searchParams;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);

  return (
    <>
      <Link href="/dashboard/menu" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Menu
      </Link>
      <PageHeader eyebrow="Catalog" title="New product" />
      <Card className="p-5 max-w-2xl">
        <form action={createProductAction} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="categoryId">Category</Label>
            <select id="categoryId" name="categoryId" defaultValue={categoryId ?? ""} required className={selectClass}>
              <option value="">Select…</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.nameEn}</option>)}
            </select>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="nameEn">Name (EN)</Label>
              <Input id="nameEn" name="nameEn" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nameAr">Name (AR)</Label>
              <Input id="nameAr" name="nameAr" required dir="rtl" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="descriptionEn">Description (EN)</Label>
              <Input id="descriptionEn" name="descriptionEn" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="descriptionAr">Description (AR)</Label>
              <Input id="descriptionAr" name="descriptionAr" dir="rtl" />
            </div>
          </div>
          <div className="grid gap-1.5 max-w-48">
            <Label htmlFor="basePrice">Base price</Label>
            <Input id="basePrice" name="basePrice" type="number" step="0.01" min="0" required />
          </div>
          <div><SubmitButton>Create product</SubmitButton></div>
        </form>
      </Card>
    </>
  );
}
