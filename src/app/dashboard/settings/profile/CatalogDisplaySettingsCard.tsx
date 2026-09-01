"use client";
import { useState } from "react";
import { Check, LayoutGrid, Rows3, Layers } from "lucide-react";
import type { CatalogDisplayMode } from "@/server/tenancy/settings";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ToastForm } from "@/components/dashboard/ToastForm";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

type DisplayOption = {
  id: CatalogDisplayMode;
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  tagEn: string;
  tagAr: string;
  icon: typeof Rows3;
};

const DISPLAY_OPTIONS: DisplayOption[] = [
  {
    id: "sections",
    titleEn: "Categorized Sections (Scroll)",
    titleAr: "أقسام متتالية (تمرير مستمر)",
    descriptionEn:
      "All products grouped by category on one continuous scrolling page with sticky navigation. Best for restaurants & cafes.",
    tagEn: "Restaurants & Cafes",
    tagAr: "للمطاعم والكافيهات",
    icon: Rows3,
  },
  {
    id: "category_grid",
    titleEn: "Category-First Grid",
    titleAr: "تصفح حسب الأقسام (شبكة)",
    descriptionEn:
      "Visual category cards on the root page. Tapping a category drills down into its items with back navigation. Best for groceries & pharmacies.",
    tagEn: "Supermarkets & Large Catalogs",
    tagAr: "للسوبرماركت والكتالوجات الكبيرة",
    icon: LayoutGrid,
  },
  {
    id: "paginated",
    titleEn: "Paginated Catalog",
    titleAr: "كتالوج مقسم لصفحات",
    descriptionEn:
      "Unified product grid with category filter pills, live search bar, and numbered page controls. Best for retail shops & boutiques.",
    tagEn: "Retail & E-Commerce",
    tagAr: "لمتاجر التجزئة",
    icon: Layers,
  },
];

export function CatalogDisplaySettingsCard({
  initialMode = "sections",
  initialItemsPerPage = 12,
  action,
}: {
  initialMode?: CatalogDisplayMode;
  initialItemsPerPage?: number;
  action: (formData: FormData) => Promise<void>;
}) {
  const [selectedMode, setSelectedMode] = useState<CatalogDisplayMode>(initialMode);
  const [itemsPerPage, setItemsPerPage] = useState<number>(initialItemsPerPage);

  return (
    <Card className="p-5 max-w-2xl mb-6">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-bold text-ink">
            Storefront Catalog Display Mode
          </h2>
          <span className="text-xs text-muted-foreground" dir="rtl">
            طريقة عرض قائمة المنتجات
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Choose how customers navigate and discover products on your public storefront.
        </p>
      </div>

      <ToastForm action={action} successMessage="Catalog display settings saved" className="space-y-4">
        <input type="hidden" name="catalogDisplayMode" value={selectedMode} />

        <div className="grid gap-3 sm:grid-cols-3">
          {DISPLAY_OPTIONS.map((opt) => {
            const isSelected = selectedMode === opt.id;
            const Icon = opt.icon;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setSelectedMode(opt.id)}
                className={`relative flex flex-col justify-between rounded-xl border p-4 text-left transition-all cursor-pointer ${
                  isSelected
                    ? "border-primary bg-primary/5 shadow-xs ring-2 ring-primary/20"
                    : "border-border bg-card hover:border-primary/40 hover:bg-muted/30"
                }`}
              >
                {isSelected && (
                  <div className="absolute top-2.5 right-2.5 rounded-full bg-primary p-0.5 text-primary-foreground">
                    <Check className="size-3.5 stroke-[3]" />
                  </div>
                )}

                <div>
                  <div className="mb-2.5 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </div>

                  <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground mb-1.5">
                    {opt.tagEn}
                  </span>

                  <h3 className="font-sans text-xs font-bold text-ink">
                    {opt.titleEn}
                  </h3>
                  <div dir="rtl" className="text-[11px] text-muted-foreground">
                    {opt.titleAr}
                  </div>

                  <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
                    {opt.descriptionEn}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        {selectedMode === "paginated" && (
          <div className="rounded-lg border border-border bg-muted/20 p-4 transition-all animate-in fade-in duration-200">
            <div className="grid gap-1.5 max-w-xs">
              <Label htmlFor="itemsPerPage" className="text-xs font-semibold">
                Products Per Page / عدد المنتجات في كل صفحة
              </Label>
              <select
                id="itemsPerPage"
                name="itemsPerPage"
                value={itemsPerPage}
                onChange={(e) => setItemsPerPage(Number(e.target.value))}
                className={selectClass}
              >
                <option value={12}>12 products per page</option>
                <option value={24}>24 products per page</option>
                <option value={48}>48 products per page</option>
              </select>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Controls the grid size before navigating to the next page.
              </p>
            </div>
          </div>
        )}

        <div className="pt-2">
          <SubmitButton className="w-fit">Save display settings</SubmitButton>
        </div>
      </ToastForm>
    </Card>
  );
}
