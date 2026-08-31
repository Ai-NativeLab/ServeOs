"use client";
import { useState, useEffect } from "react";
import { ArrowLeft, Search } from "lucide-react";
import type { PublishedMenu } from "@/server/catalog/schema";
import type { Cart } from "@/app/_components/cart";
import { getSimpleProductQuantity } from "@/app/_components/cart";
import { ProductCard, type MenuProduct } from "@/app/_components/storefront/ProductCard";
import { FeaturedCard } from "@/app/_components/storefront/FeaturedCard";
import { SectionHeader } from "@/app/_components/storefront/SectionHeader";
import { isNewProduct } from "@/lib/product-badges";

export function CategoryGridView({
  menu,
  currency,
  orderingEnabled,
  popularIds,
  cart,
  needsBranchPick,
  onOpenProduct,
  onPickBranch,
  onUpdateQuantity,
  renderProductCard,
}: {
  menu: PublishedMenu;
  currency: string;
  orderingEnabled: boolean;
  popularIds: string[];
  cart: Cart;
  needsBranchPick: boolean;
  onOpenProduct: (p: MenuProduct) => void;
  onPickBranch: (productId: string) => void;
  onUpdateQuantity: (
    product: { id: string; nameEn: string; nameAr: string; effectivePrice: number },
    delta: number,
  ) => void;
  renderProductCard?: (product: MenuProduct) => React.ReactNode;
}) {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Sync with ?category= URL search param and handle browser back/forward
  useEffect(() => {
    const updateFromUrl = () => {
      const catParam = new URLSearchParams(window.location.search).get("category");
      if (catParam && menu.categories.some((c) => c.id === catParam)) {
        setSelectedCategoryId(catParam);
      } else {
        setSelectedCategoryId(null);
      }
    };

    updateFromUrl();
    window.addEventListener("popstate", updateFromUrl);
    return () => window.removeEventListener("popstate", updateFromUrl);
  }, [menu]);

  const selectCategory = (catId: string) => {
    setSelectedCategoryId(catId);
    const params = new URLSearchParams(window.location.search);
    params.set("category", catId);
    window.history.pushState(null, "", `?${params.toString()}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const clearCategory = () => {
    setSelectedCategoryId(null);
    const params = new URLSearchParams(window.location.search);
    params.delete("category");
    const qs = params.toString();
    window.history.pushState(null, "", qs ? `?${qs}` : window.location.pathname);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const selectedCategory = menu.categories.find((c) => c.id === selectedCategoryId) ?? null;

  // If user is searching globally across categories
  const isSearching = searchQuery.trim().length > 0;
  const filteredProducts = isSearching
    ? menu.categories
        .flatMap((c) => c.products)
        .filter((p) => {
          const q = searchQuery.toLowerCase();
          return (
            p.nameEn.toLowerCase().includes(q) ||
            p.nameAr.includes(searchQuery) ||
            p.descriptionEn?.toLowerCase().includes(q) ||
            p.brand?.toLowerCase().includes(q)
          );
        })
    : [];

  return (
    <div className="py-4">
      {/* Search Bar */}
      <div className="mb-6 relative">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search items across all categories / ابحث في جميع الأقسام…"
          aria-label="Search catalog"
          className="w-full rounded-full border border-border bg-card px-4 py-2.5 pl-10 text-base text-ink outline-none transition-colors focus:border-primary/60 sm:text-sm"
        />
        <Search className="absolute left-3.5 top-3 size-4 text-muted-foreground pointer-events-none" />
      </div>

      {isSearching ? (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-display font-bold text-ink">
              Search results for “{searchQuery}” ({filteredProducts.length})
            </h3>
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="text-xs text-muted-foreground hover:text-ink transition-colors"
            >
              Clear search
            </button>
          </div>

          {filteredProducts.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No products found matching “{searchQuery}”.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {filteredProducts.map((p) =>
                renderProductCard ? (
                  renderProductCard(p)
                ) : (
                  <ProductCard
                    key={p.id}
                    product={p}
                    interactive={orderingEnabled}
                    onOpen={() => (needsBranchPick ? onPickBranch(p.id) : onOpenProduct(p))}
                    currency={currency}
                    badge={popularIds.includes(p.id) ? "popular" : isNewProduct(p.createdAt) ? "new" : null}
                    quantity={getSimpleProductQuantity(cart, p.id)}
                    onQuickAdd={() => {
                      if (needsBranchPick) onPickBranch(p.id);
                      else onUpdateQuantity(p, 1);
                    }}
                    onIncrement={() => {
                      if (needsBranchPick) onPickBranch(p.id);
                      else onUpdateQuantity(p, 1);
                    }}
                    onDecrement={() => onUpdateQuantity(p, -1)}
                  />
                ),
              )}
            </div>
          )}
        </div>
      ) : selectedCategory ? (
        /* Drilldown View: Single Category */
        <div>
          <button
            type="button"
            onClick={clearCategory}
            className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:text-primary/80 transition-colors mb-4 cursor-pointer"
          >
            <ArrowLeft className="size-4" strokeWidth={2} />
            <span>All Categories</span>
            <span dir="rtl" className="text-xs font-normal opacity-80">
              / جميع الأقسام
            </span>
          </button>

          <SectionHeader
            eyebrow={selectedCategory.nameAr}
            title={selectedCategory.nameEn}
            count={selectedCategory.products.length}
          />

          {(() => {
            const featured = selectedCategory.products.find((p) => p.isFeatured) ?? null;
            const rest = selectedCategory.products.filter((p) => p.id !== featured?.id);
            return (
              <>
                {featured && (
                  <div className="mt-4">
                    <FeaturedCard
                      product={featured}
                      currency={currency}
                      interactive={orderingEnabled}
                      onOpen={() => (needsBranchPick ? onPickBranch(featured.id) : onOpenProduct(featured))}
                    />
                  </div>
                )}
                <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  {rest.map((p) =>
                    renderProductCard ? (
                      renderProductCard(p)
                    ) : (
                      <ProductCard
                        key={p.id}
                        product={p}
                        interactive={orderingEnabled}
                        onOpen={() => (needsBranchPick ? onPickBranch(p.id) : onOpenProduct(p))}
                        currency={currency}
                        badge={popularIds.includes(p.id) ? "popular" : isNewProduct(p.createdAt) ? "new" : null}
                        quantity={getSimpleProductQuantity(cart, p.id)}
                        onQuickAdd={() => {
                          if (needsBranchPick) onPickBranch(p.id);
                          else onUpdateQuantity(p, 1);
                        }}
                        onIncrement={() => {
                          if (needsBranchPick) onPickBranch(p.id);
                          else onUpdateQuantity(p, 1);
                        }}
                        onDecrement={() => onUpdateQuantity(p, -1)}
                      />
                    ),
                  )}
                </div>
              </>
            );
          })()}
        </div>
      ) : (
        /* Root View: Category Cards Grid */
        <div>
          <h3 className="eyebrow text-primary mb-4">Browse by Category / تصفح حسب القسم</h3>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {menu.categories.map((cat) => (
              <div
                key={cat.id}
                role="button"
                tabIndex={0}
                onClick={() => selectCategory(cat.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectCategory(cat.id);
                  }
                }}
                className="card-lift card-lift-hover group flex flex-col overflow-hidden rounded-2xl bg-card text-left cursor-pointer border border-border/70 transition-all hover:border-primary/40 shadow-xs"
              >
                <div className="relative aspect-[16/10] w-full overflow-hidden bg-muted">
                  {cat.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={cat.imageUrl}
                      alt={cat.nameEn}
                      loading="lazy"
                      className="sf-img h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-primary/10 text-primary font-display font-bold text-2xl">
                      {cat.nameEn.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="absolute bottom-2 right-2 rounded-full bg-ink/80 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-xs">
                    {cat.products.length} {cat.products.length === 1 ? "item" : "items"}
                  </span>
                </div>

                <div className="flex flex-1 flex-col p-3.5 justify-between">
                  <div>
                    <h4 className="font-sans text-sm font-bold text-ink group-hover:text-primary transition-colors">
                      {cat.nameEn}
                    </h4>
                    {cat.nameAr && (
                      <span dir="rtl" className="block text-xs text-muted-foreground mt-0.5">
                        {cat.nameAr}
                      </span>
                    )}
                  </div>
                  <span className="mt-2 text-xs font-semibold text-primary flex items-center gap-1">
                    Explore →
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
