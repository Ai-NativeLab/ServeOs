"use client";
import { useEffect, useState } from "react";
import type { PublishedMenu } from "@/server/catalog/schema";
import { addLine, loadCart, setLineQuantity, cartSubtotal, type Cart } from "./cart";
import { CategoryNav } from "./storefront/CategoryNav";
import { ProductCard, type MenuProduct } from "./storefront/ProductCard";
import { ProductSheet } from "./storefront/ProductSheet";
import { CartBar } from "./storefront/CartBar";
import { BranchPickSheet } from "./storefront/BranchPickSheet";
import { CartDrawer } from "./storefront/CartDrawer";

export function StorefrontMenu({
  menu, branchId, slug, orderingEnabled, branches, currency, preorderOnly, popularIds,
}: {
  menu: PublishedMenu;
  branchId: string | null;
  slug: string;
  orderingEnabled: boolean;
  preorderOnly: boolean;
  branches: { id: string; name: string; open: boolean }[];
  currency: string;
  popularIds: string[];
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
      <CategoryNav categories={menu.categories.map((c) => ({ id: c.id, nameEn: c.nameEn }))} />

      {menu.categories.map((cat) => (
        <div key={cat.id} id={`category-${cat.id}`} className="scroll-mt-32 py-6">
          <h2 className="font-display text-xl font-bold text-ink">
            {cat.nameEn} <span className="font-sans text-base font-normal text-muted-foreground">/ {cat.nameAr}</span>
          </h2>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {cat.products.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                interactive={orderingEnabled}
                onOpen={() => (needsBranchPick ? setBranchPickFor(p.id) : setActiveProduct(p))}
                currency={currency}
              />
            ))}
          </div>
        </div>
      ))}

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
