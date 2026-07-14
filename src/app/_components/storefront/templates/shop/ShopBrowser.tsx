"use client";
import { useEffect, useState } from "react";
import type { PublishedMenu } from "@/server/catalog/schema";
import { addLine, loadCart, setLineQuantity, cartSubtotal, type Cart } from "@/app/_components/cart";
import { type MenuProduct } from "@/app/_components/storefront/ProductCard";
import { CartBar } from "@/app/_components/storefront/CartBar";
import { BranchPickSheet } from "@/app/_components/storefront/BranchPickSheet";
import { CartDrawer } from "@/app/_components/storefront/CartDrawer";
import { SectionHeader } from "@/app/_components/storefront/SectionHeader";
import { ShopProductCard } from "./ShopProductCard";
import { RetailProductSheet } from "./RetailProductSheet";
import { filterCatalog } from "./shop-search";

export function ShopBrowser({
  menu, branchId, slug, orderingEnabled, branches, currency, preorderOnly,
}: {
  menu: PublishedMenu;
  branchId: string | null;
  slug: string;
  orderingEnabled: boolean;
  preorderOnly: boolean;
  branches: { id: string; name: string; open: boolean }[];
  currency: string;
}) {
  const [cart, setCart] = useState<Cart>({ branchId: null, lines: [] });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeProduct, setActiveProduct] = useState<MenuProduct | null>(null);
  const [branchPickFor, setBranchPickFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const needsBranchPick = branchId === null && branches.length > 1;

  useEffect(() => {
    const onChange = () => setCart(loadCart());
    onChange();
    window.addEventListener("serveos-cart-changed", onChange);
    return () => window.removeEventListener("serveos-cart-changed", onChange);
  }, []);

  function add(p: MenuProduct, variantId: string | null, quantity: number) {
    const v = variantId ? p.variants.find((x) => x.id === variantId) : null;
    setCart(addLine(branchId, {
      productId: p.id,
      variantId: v?.id,
      variantNameEn: v?.nameEn,
      nameEn: p.nameEn, nameAr: p.nameAr, quantity,
      unitPrice: v ? v.price : p.effectivePrice,
      selectedOptionIds: [],
      modifierSummaryEn: v?.nameEn ?? "", // CartDrawer renders this as the line summary
    }));
  }

  const itemCount = cart.lines.reduce((s, l) => s + l.quantity, 0);
  const visible = filterCatalog(menu.categories, query);

  return (
    <>
      <div className="sticky top-0 z-20 -mx-4 bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search products or brands…"
          aria-label="Search products"
          className="w-full rounded-full border border-border bg-card px-4 py-2.5 text-base text-ink outline-none transition-colors focus:border-primary/60 sm:text-sm"
        />
      </div>

      {visible.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">No products match “{query}”.</p>
      )}

      {visible.map((cat) => (
        <div key={cat.id} id={`category-${cat.id}`} className="scroll-mt-32 py-6">
          <SectionHeader eyebrow={cat.nameAr} title={cat.nameEn} count={cat.products.length} />
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {cat.products.map((p) => (
              <ShopProductCard
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
          <RetailProductSheet
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
