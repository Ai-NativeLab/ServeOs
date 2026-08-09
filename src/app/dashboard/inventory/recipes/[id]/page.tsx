import Link from "next/link";
import { notFound } from "next/navigation";
import { requireInventoryPermission } from "../../../inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { getRecipe, listProductLinks } from "@/server/inventory/recipes";
import { listItems } from "@/server/inventory/read";
import { listProducts } from "@/server/catalog/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RecipeComponentsEditor } from "./RecipeComponentsEditor";
import { LinkProductForm } from "./LinkProductForm";

export default async function RecipeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:view");
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return (
        <>
          <PageHeader eyebrow="Recipe" title="Recipe" />
          <EmptyState title="Not authorized" description="Viewing recipes needs the inventory:view permission." />
        </>
      );
    }
    throw e;
  }

  const { id } = await params;
  const [recipe, items, products, links] = await Promise.all([
    getRecipe(ctx.tenantId, id),
    listItems(ctx.tenantId, { isActive: true, limit: 200 }),
    listProducts(ctx.tenantId),
    listProductLinks(ctx.tenantId),
  ]);
  if (!recipe) notFound();

  const linkedProduct = products.find((p) => links.some((l) => l.recipeId === recipe.id && l.productId === p.id));

  return (
    <>
      <PageHeader
        eyebrow="Recipe"
        title={recipe.nameEn}
        description={`One batch yields ${Number(recipe.yieldQty)}. Selling ${Number(recipe.yieldQty) === 1 ? "one" : `${Number(recipe.yieldQty)}`} deducts exactly the quantities below; other amounts scale pro rata.`}
        action={<Button asChild variant="ghost" size="sm"><Link href="/dashboard/inventory/recipes">Back</Link></Button>}
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr] items-start">
        <Card className="p-6">
          <h2 className="font-medium mb-1">Ingredients</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Each line is checked against the ingredient&apos;s own unit when you save — grams cannot be
            given in millilitres, because density isn&apos;t modelled. Waste covers trim and yield loss.
          </p>
          {items.length === 0 ? (
            <EmptyState
              title="No stock items yet"
              description="Create the ingredients you hold before building a recipe from them."
            />
          ) : (
            <RecipeComponentsEditor
              recipeId={recipe.id}
              items={items.map((i) => ({ id: i.id, nameEn: i.nameEn, baseUom: i.baseUom }))}
              components={recipe.components.map((c) => ({
                itemId: c.itemId, qty: String(Number(c.qty)), uom: c.uom, wastePct: String(Number(c.wastePct)),
              }))}
            />
          )}
        </Card>

        <Card className="p-6">
          <h2 className="font-medium mb-1">Sold as</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Until a dish points at this recipe, selling it deducts nothing.
          </p>
          {linkedProduct ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">linked</Badge>
                <span className="font-medium">{linkedProduct.nameEn}</span>
              </div>
              <LinkProductForm
                recipeId={recipe.id}
                products={products.map((p) => ({ id: p.id, nameEn: p.nameEn }))}
                currentProductId={linkedProduct.id}
              />
            </div>
          ) : (
            <LinkProductForm
              recipeId={recipe.id}
              products={products.map((p) => ({ id: p.id, nameEn: p.nameEn }))}
              currentProductId={null}
            />
          )}
        </Card>
      </div>
    </>
  );
}
