import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { createCategoryAction } from "../actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function NewCategoryPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");

  return (
    <>
      <Link href="/dashboard/menu" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Menu
      </Link>
      <PageHeader eyebrow="Catalog" title="New category" />
      <Card className="p-5 max-w-2xl">
        <form action={createCategoryAction} className="grid gap-4">
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
          <div><SubmitButton>Create category</SubmitButton></div>
        </form>
      </Card>
    </>
  );
}
