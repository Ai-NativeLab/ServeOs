import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories } from "@/server/catalog/service";
import { updateCategoryAction } from "../actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ImageInput } from "@/components/dashboard/ImageInput";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function EditCategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);
  const cat = cats.find((c) => c.id === id);
  if (!cat) notFound();

  return (
    <>
      <Link href="/dashboard/menu" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Menu
      </Link>
      <PageHeader eyebrow="Catalog" title={cat.nameEn} />
      <Card className="p-5 max-w-2xl">
        <form action={updateCategoryAction.bind(null, id)} className="grid gap-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="nameEn">Name (EN)</Label>
              <Input id="nameEn" name="nameEn" defaultValue={cat.nameEn} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nameAr">Name (AR)</Label>
              <Input id="nameAr" name="nameAr" defaultValue={cat.nameAr} required dir="rtl" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Category image</Label>
            <ImageInput name="imageUrl" type="category" defaultValue={cat.imageUrl} aspect="square" />
          </div>
          <div><SubmitButton>Save changes</SubmitButton></div>
        </form>
      </Card>
    </>
  );
}
