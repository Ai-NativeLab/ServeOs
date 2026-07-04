import Link from "next/link";
import { Plus, Pencil, ImageIcon } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories, listProducts } from "@/server/catalog/service";
import { deleteCategoryAction } from "./categories/actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export default async function MenuPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);
  const prods = await listProducts(ctx.tenantId);

  return (
    <>
      <PageHeader
        eyebrow="Catalog"
        title="Menu"
        description="Categories and products your customers can order."
        action={
          <Button asChild>
            <Link href="/dashboard/menu/categories/new"><Plus className="size-4" />New category</Link>
          </Button>
        }
      />

      {cats.length === 0 ? (
        <EmptyState
          title="No menu yet"
          description="Start with a category — like Pizzas or Drinks — then add products to it."
          action={<Button asChild><Link href="/dashboard/menu/categories/new"><Plus className="size-4" />New category</Link></Button>}
        />
      ) : (
        <div className="space-y-6">
          {cats.map((cat) => {
            const catProds = prods.filter((p) => p.categoryId === cat.id);
            return (
              <Card key={cat.id} className="p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <h2 className="font-display text-lg font-bold text-ink">{cat.nameEn}</h2>
                    <div className="text-sm text-muted-foreground" dir="rtl">{cat.nameAr}</div>
                  </div>
                  <div className="flex gap-2">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/dashboard/menu/categories/${cat.id}`}><Pencil className="size-4" />Edit</Link>
                    </Button>
                    {catProds.length === 0 && (
                      <ConfirmActionButton
                        action={deleteCategoryAction.bind(null, cat.id)}
                        label="Delete"
                        size="sm"
                        title={`Delete "${cat.nameEn}"?`}
                        description="This empty category will be removed from your menu."
                        successMessage="Category deleted"
                      />
                    )}
                  </div>
                </div>

                {catProds.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">No products in this category yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="eyebrow w-14"></TableHead>
                        <TableHead className="eyebrow">Product</TableHead>
                        <TableHead className="eyebrow text-right">Price</TableHead>
                        <TableHead className="eyebrow">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {catProds.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell>
                            {p.imageUrl
                              ? /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={p.imageUrl} alt="" className="size-10 rounded-md object-cover" />
                              : <span className="size-10 rounded-md bg-secondary grid place-items-center"><ImageIcon className="size-4 text-muted-foreground" strokeWidth={1.5} /></span>}
                          </TableCell>
                          <TableCell>
                            <Link href={`/dashboard/menu/products/${p.id}`} className="font-medium text-ink hover:underline">{p.nameEn}</Link>
                          </TableCell>
                          <TableCell className="font-mono text-sm text-right">{Number(p.basePrice).toFixed(2)}</TableCell>
                          <TableCell>
                            <span className={p.isPublished
                              ? "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-status-ready/15 text-status-ready-fg ring-1 ring-status-ready/30"
                              : "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-secondary text-muted-foreground"}>
                              {p.isPublished ? "Published" : "Draft"}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                <Button asChild variant="outline" size="sm" className="mt-3">
                  <Link href={`/dashboard/menu/products/new?categoryId=${cat.id}`}><Plus className="size-4" />Add product</Link>
                </Button>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
