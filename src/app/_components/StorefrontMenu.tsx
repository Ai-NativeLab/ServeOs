"use client";
import { useEffect, useState } from "react";
import type { PublishedMenu } from "@/server/catalog/schema";
import { addLine, loadCart, removeLine, cartSubtotal, type Cart } from "./cart";
import { CategoryNav } from "./storefront/CategoryNav";
import { ProductCard, type MenuProduct } from "./storefront/ProductCard";
import { ProductSheet } from "./storefront/ProductSheet";
import { CartBar } from "./storefront/CartBar";

export function StorefrontMenu({
  menu, branchId, slug, orderingEnabled,
}: {
  menu: PublishedMenu;
  branchId: string | null;
  slug: string;
  orderingEnabled: boolean;
}) {
  const [cart, setCart] = useState<Cart>({ branchId: null, lines: [] });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeProduct, setActiveProduct] = useState<MenuProduct | null>(null);

  useEffect(() => {
    const onChange = () => setCart(loadCart());
    onChange();
    window.addEventListener("serveos-cart-changed", onChange);
    return () => window.removeEventListener("serveos-cart-changed", onChange);
  }, []);

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
              <ProductCard key={p.id} product={p} interactive={orderingEnabled} onOpen={() => setActiveProduct(p)} />
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
          />
          <CartBar count={itemCount} subtotal={cartSubtotal(cart.lines)} onOpen={() => setDrawerOpen(true)} />
          {drawerOpen && (
            <CartDrawer cart={cart} slug={slug} onClose={() => setDrawerOpen(false)} onRemove={(i) => setCart(removeLine(i))} />
          )}
        </>
      )}
    </>
  );
}

function CartDrawer({
  cart, slug, onClose, onRemove,
}: {
  cart: Cart;
  slug: string;
  onClose: () => void;
  onRemove: (i: number) => void;
}) {
  const subtotal = cartSubtotal(cart.lines);
  return (
    <div className="fixed inset-0 z-30 bg-black/40" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-y-0 right-0 flex w-[340px] max-w-[90vw] flex-col overflow-y-auto bg-card p-4"
      >
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg font-bold text-ink">Your cart</h3>
          <button onClick={onClose} className="text-2xl leading-none text-muted-foreground" aria-label="Close cart">
            ×
          </button>
        </div>
        {cart.lines.length === 0 && <p className="mt-4 text-sm text-muted-foreground">Cart is empty.</p>}
        {cart.lines.map((l, i) => (
          <div key={i} className="flex items-center justify-between border-b border-border py-2">
            <div>
              <div>{l.quantity}× {l.nameEn}</div>
              {l.modifierSummaryEn && <div className="text-xs text-muted-foreground">{l.modifierSummaryEn}</div>}
            </div>
            <div className="text-right">
              {(l.unitPrice * l.quantity).toFixed(2)}
              <br />
              <button onClick={() => onRemove(i)} className="text-xs text-destructive">
                Remove
              </button>
            </div>
          </div>
        ))}
        <div className="mt-3 flex justify-between font-bold text-ink">
          <span>Subtotal</span>
          <span>{subtotal.toFixed(2)}</span>
        </div>
        {cart.lines.length > 0 && (
          <a
            href={`/checkout?slug=${encodeURIComponent(slug)}${cart.branchId ? `&branch=${cart.branchId}` : ""}`}
            className="mt-4 block rounded-md bg-primary p-3 text-center font-semibold text-primary-foreground"
          >
            Checkout →
          </a>
        )}
      </div>
    </div>
  );
}
