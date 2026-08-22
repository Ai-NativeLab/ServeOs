import Link from "next/link";
import { requireInventoryPermission } from "../../inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { CapabilityNotEnabledError } from "@/server/verticals/errors";
import { listRecipes, listProductLinks } from "@/server/inventory/recipes";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { createRecipeAction } from "../actions";

export default async function RecipesPage() {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:view");
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return (
        <>
          <PageHeader eyebrow="Inventory" title="Recipes" />
          <EmptyState title="Not authorized" description="Viewing recipes needs the inventory:view permission." />
        </>
      );
    }
    throw e;
  }

  let recipes;
  try {
    recipes = await listRecipes(ctx.tenantId);
  } catch (e) {
    // Recipes are restaurant-only. Saying so plainly beats an empty table that
    // looks like the tenant simply has not made one yet.
    if (e instanceof CapabilityNotEnabledError) {
      return (
        <>
          <PageHeader eyebrow="Inventory" title="Recipes" />
          <EmptyState
            title="Recipes aren't available for this business type"
            description="A recipe deducts ingredients when a made-to-order dish is sold, so it only applies to restaurants. Retail stock is linked directly to a finished-goods item instead."
          />
        </>
      );
    }
    throw e;
  }

  const links = await listProductLinks(ctx.tenantId);
  const linkedRecipeIds = new Set(links.filter((l) => l.recipeId).map((l) => l.recipeId));

  return (
    <>
      <PageHeader
        eyebrow="Inventory"
        title="Recipes"
        description="A recipe is the bill of materials for one dish. Selling the dish deducts each ingredient from the branch kitchen, scaled by how much was sold."
      />

      <Card className="p-6 mb-6 max-w-2xl">
        <ToastForm action={createRecipeAction} successMessage="Recipe created" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="nameEn">New recipe</Label>
              <Input id="nameEn" name="nameEn" required placeholder="Margherita" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="yieldQty">Yields</Label>
              {/* Components are scaled by soldQty / yieldQty, so a batch that
                  makes 2 pizzas consumes half its ingredients per pizza sold. */}
              <Input id="yieldQty" name="yieldQty" type="number" step="0.001" min="0.001" defaultValue="1" />
            </div>
          </div>
          <input type="hidden" name="nameAr" value="" />
          <SubmitButton>Create recipe</SubmitButton>
        </ToastForm>
      </Card>

      {recipes.length === 0 ? (
        <EmptyState
          title="No recipes yet"
          description="Create one above, then add its ingredients and link it to the dish you sell."
        />
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recipe</TableHead>
                <TableHead className="text-right">Yields</TableHead>
                <TableHead>Linked to a dish</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipes.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.nameEn}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.yieldQty)}</TableCell>
                  <TableCell>
                    {linkedRecipeIds.has(r.id)
                      ? <Badge variant="secondary">linked</Badge>
                      // An unlinked recipe deducts nothing — it is inert until a
                      // product points at it, which is the most common mistake.
                      : <span className="text-muted-foreground text-sm">not linked — deducts nothing</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link href={`/dashboard/inventory/recipes/${r.id}`} className="text-sm text-primary hover:underline">
                      Edit
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
