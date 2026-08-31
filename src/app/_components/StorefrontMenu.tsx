"use client";
import { useEffect, useState } from "react";
import type { PublishedMenu } from "@/server/catalog/schema";
import {
  addLine,
  loadCart,
  setLineQuantity,
  cartSubtotal,
  getSimpleProductQuantity,
  updateSimpleProductQuantity,
  type Cart,
} from "./cart";
import { CategoryNav } from "./storefront/CategoryNav";
import { ProductCard, type MenuProduct } from "./storefront/ProductCard";
import { ProductSheet } from "./storefront/ProductSheet";
import { CartBar } from "./storefront/CartBar";
import { BranchPickSheet } from "./storefront/BranchPickSheet";
import { CartDrawer } from "./storefront/CartDrawer";
import { SectionHeader } from "./storefront/SectionHeader";
import { FeaturedCard } from "./storefront/FeaturedCard";
import { isNewProduct } from "@/lib/product-badges";
import { CategoryGridView } from "./storefront/templates/CategoryGridView";
import { PaginatedCatalogView } from "./storefront/templates/PaginatedCatalogView";
import type { CatalogDisplayMode } from "@/server/tenancy/settings";

export function StorefrontMenu({
  menu, branchId, slug, orderingEnabled, branches, currency, preorderOnly, popularIds,
  catalogDisplayMode = "sections", itemsPerPage = 12,
}: {
  menu: PublishedMenu;
  branchId: string | null;
  slug: string;
  orderingEnabled: boolean;
  preorderOnly: boolean;
  branches: { id: string; name: string; open: boolean }[];
  currency: string;
  popularIds: string[];
  catalogDisplayMode?: CatalogDisplayMode;
  itemsPerPage?: number;
}) {
  const [cart, setCart] = useState<Cart>({ branchId: null, lines: [] });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeProduct, setActiveProduct] = useState<MenuProduct | null>(null);
  const [branchPickFor, setBranchPickFor] = useState<string | null>(null);
  const needsBranchPick = branchId === null && branches.length > 1;

  useEffect(() => {
    const onChange = () => setCart(loadCart());
    onChange();
    window.addEventListener("serveos-cart-changed", onChange);
    return () => window.removeEventListener("serveos-cart-changed", onChange);
  }, []);

  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("product");
    if (!wanted) return;
    const product = menu.categories.flatMap((c) => c.products).find((p) => p.id === wanted);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening a deep-linked product (?product=) from the URL on mount
    if (product) setActiveProduct(product);
    const params = new URLSearchParams(window.location.search);
    params.delete("product");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [menu]);

  function add(p: MenuProduct, optionIds: string[], quantity: number) {
    const deltas = p.modifierGroups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id)).reduce((s, o) => s + Number(o.priceDelta), 0);
    const summary = p.modifierGroups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id)).map((o) => o.nameEn).join(", ");
    setCart(addLine(branchId, {
      productId: p.id, nameEn: p.nameEn, nameAr: p.nameAr, quantity,
      unitPrice: p.effectivePrice + deltas, selectedOptionIds: optionIds, modifierSummaryEn: summary,
    }));
  }

  const itemCount = cart.lines.reduce((s, l) => s + l.quantity, 0);

  return (
    <>
      {catalogDisplayMode === "category_grid" ? (
        <CategoryGridView
          menu={menu}
          currency={currency}
          orderingEnabled={orderingEnabled}
          popularIds={popularIds}
          cart={cart}
          needsBranchPick={needsBranchPick}
          onOpenProduct={(p) => setActiveProduct(p)}
          onPickBranch={(pid) => setBranchPickFor(pid)}
          onUpdateQuantity={(p, delta) => {
            setCart(updateSimpleProductQuantity(branchId, p, delta));
          }}
        />
      ) : catalogDisplayMode === "paginated" ? (
        <PaginatedCatalogView
          menu={menu}
          currency={currency}
          orderingEnabled={orderingEnabled}
          popularIds={popularIds}
          cart={cart}
          needsBranchPick={needsBranchPick}
          itemsPerPage={itemsPerPage}
          onOpenProduct={(p) => setActiveProduct(p)}
          onPickBranch={(pid) => setBranchPickFor(pid)}
          onUpdateQuantity={(p, delta) => {
            setCart(updateSimpleProductQuantity(branchId, p, delta));
          }}
        />
      ) : (
        <>
          <CategoryNav categories={menu.categories.map((c) => ({ id: c.id, nameEn: c.nameEn }))} />

          {menu.categories.map((cat) => {
            const featured = cat.products.find((p) => p.isFeatured) ?? null;
            const rest = cat.products.filter((p) => p.id !== featured?.id);
            return (
              <div key={cat.id} id={`category-${cat.id}`} className="scroll-mt-32 py-6">
                <SectionHeader eyebrow={cat.nameAr} title={cat.nameEn} count={cat.products.length} />
                {featured && (
                  <div className="mt-4">
                    <FeaturedCard
                      product={featured}
                      currency={currency}
                      interactive={orderingEnabled}
                      onOpen={() => (needsBranchPick ? setBranchPickFor(featured.id) : setActiveProduct(featured))}
                    />
                  </div>
                )}
                <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  {rest.map((p) => {
                    const simpleQty = getSimpleProductQuantity(cart, p.id);
                    return (
                      <ProductCard
                        key={p.id}
                        product={p}
                        interactive={orderingEnabled}
                        onOpen={() => (needsBranchPick ? setBranchPickFor(p.id) : setActiveProduct(p))}
                        currency={currency}
                        badge={popularIds.includes(p.id) ? "popular" : isNewProduct(p.createdAt) ? "new" : null}
                        quantity={simpleQty}
                        onQuickAdd={() => {
                          if (needsBranchPick) {
                            setBranchPickFor(p.id);
                          } else {
                            setCart(
                              updateSimpleProductQuantity(
                                branchId,
                                { id: p.id, nameEn: p.nameEn, nameAr: p.nameAr, effectivePrice: p.effectivePrice },
                                1,
                              ),
                            );
                          }
                        }}
                        onIncrement={() => {
                          if (needsBranchPick) {
                            setBranchPickFor(p.id);
                          } else {
                            setCart(
                              updateSimpleProductQuantity(
                                branchId,
                                { id: p.id, nameEn: p.nameEn, nameAr: p.nameAr, effectivePrice: p.effectivePrice },
                                1,
                              ),
                            );
                          }
                        }}
                        onDecrement={() => {
                          setCart(
                            updateSimpleProductQuantity(
                              branchId,
                              { id: p.id, nameEn: p.nameEn, nameAr: p.nameAr, effectivePrice: p.effectivePrice },
                              -1,
                            ),
                          );
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}

      {orderingEnabled && (
        <>
          <ProductSheet
            product={activeProduct}
            open={activeProduct !== null}
            onOpenChange={(open) => !open && setActiveProduct(null)}
            onAdd={add}
            currency={currency}
          />
          <BranchPickSheet
            branches={branches}
            open={branchPickFor !== null}
            onOpenChange={(o) => !o && setBranchPickFor(null)}
            productId={branchPickFor}
          />
          <CartBar count={itemCount} subtotal={cartSubtotal(cart.lines)} onOpen={() => setDrawerOpen(true)} currency={currency} />
          <CartDrawer
            cart={cart}
            slug={slug}
            currency={currency}
            preorderOnly={preorderOnly}
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            onSetQuantity={(i, q) => setCart(setLineQuantity(i, q))}
          />
        </>
      )}
    </>
  );
}
