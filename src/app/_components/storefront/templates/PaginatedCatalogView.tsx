"use client";
import { useState, useEffect, useMemo } from "react";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import type { PublishedMenu } from "@/server/catalog/schema";
import type { Cart } from "@/app/_components/cart";
import { getSimpleProductQuantity } from "@/app/_components/cart";
import { ProductCard, type MenuProduct } from "@/app/_components/storefront/ProductCard";
import { isNewProduct } from "@/lib/product-badges";

export function PaginatedCatalogView({
  menu,
  currency,
  orderingEnabled,
  popularIds,
  cart,
  needsBranchPick,
  itemsPerPage = 12,
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
  itemsPerPage?: number;
  onOpenProduct: (p: MenuProduct) => void;
  onPickBranch: (productId: string) => void;
  onUpdateQuantity: (
    product: { id: string; nameEn: string; nameAr: string; effectivePrice: number },
    delta: number,
  ) => void;
  renderProductCard?: (product: MenuProduct) => React.ReactNode;
}) {
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState<number>(1);

  // Sync with URL ?page= and ?category=
  useEffect(() => {
    const updateFromUrl = () => {
      const p = Number(new URLSearchParams(window.location.search).get("page"));
      const cat = new URLSearchParams(window.location.search).get("category");
      if (!Number.isNaN(p) && p >= 1) setCurrentPage(p);
      if (cat && (cat === "all" || menu.categories.some((c) => c.id === cat))) {
        setSelectedCategory(cat);
      }
    };
    updateFromUrl();
    window.addEventListener("popstate", updateFromUrl);
    return () => window.removeEventListener("popstate", updateFromUrl);
  }, [menu]);

  const setPage = (pageNumber: number) => {
    setCurrentPage(pageNumber);
    const params = new URLSearchParams(window.location.search);
    params.set("page", String(pageNumber));
    window.history.pushState(null, "", `?${params.toString()}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const setCategoryFilter = (catId: string) => {
    setSelectedCategory(catId);
    setCurrentPage(1);
    const params = new URLSearchParams(window.location.search);
    if (catId === "all") params.delete("category");
    else params.set("category", catId);
    params.set("page", "1");
    window.history.pushState(null, "", `?${params.toString()}`);
  };

  // Filter products by category and search
  const filteredProducts = useMemo(() => {
    let pool =
      selectedCategory === "all"
        ? menu.categories.flatMap((c) => c.products)
        : (menu.categories.find((c) => c.id === selectedCategory)?.products ?? []);

    if (searchQuery.trim().length > 0) {
      const q = searchQuery.toLowerCase();
      pool = pool.filter(
        (p) =>
          p.nameEn.toLowerCase().includes(q) ||
          p.nameAr.includes(searchQuery) ||
          p.descriptionEn?.toLowerCase().includes(q) ||
          p.brand?.toLowerCase().includes(q),
      );
    }
    return pool;
  }, [menu, selectedCategory, searchQuery]);

  const totalItems = filteredProducts.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);

  const pagedProducts = useMemo(() => {
    const start = (safePage - 1) * itemsPerPage;
    return filteredProducts.slice(start, start + itemsPerPage);
  }, [filteredProducts, safePage, itemsPerPage]);

  const totalAllProducts = menu.categories.reduce((s, c) => s + c.products.length, 0);

  return (
    <div className="py-4 space-y-6">
      {/* Search Bar */}
      <div className="relative">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setCurrentPage(1);
          }}
          placeholder="Search products or brands / ابحث عن المنتجات…"
          aria-label="Search catalog"
          className="w-full rounded-full border border-border bg-card px-4 py-2.5 pl-10 text-base text-ink outline-none transition-colors focus:border-primary/60 sm:text-sm"
        />
        <Search className="absolute left-3.5 top-3 size-4 text-muted-foreground pointer-events-none" />
      </div>

      {/* Category Filter Pills (Horizontal Scrollable) */}
      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
        <button
          type="button"
          onClick={() => setCategoryFilter("all")}
          className={`shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition-all cursor-pointer ${
            selectedCategory === "all"
              ? "bg-primary text-primary-foreground shadow-xs"
              : "border border-border bg-card text-muted-foreground hover:bg-muted/50"
          }`}
        >
          All Items ({totalAllProducts})
        </button>
        {menu.categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            onClick={() => setCategoryFilter(cat.id)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition-all cursor-pointer ${
              selectedCategory === cat.id
                ? "bg-primary text-primary-foreground shadow-xs"
                : "border border-border bg-card text-muted-foreground hover:bg-muted/50"
            }`}
          >
            {cat.nameEn} ({cat.products.length})
          </button>
        ))}
      </div>

      {/* Product Grid */}
      {pagedProducts.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No products found matching your filter.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {pagedProducts.map((p) =>
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

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-border pt-6 mt-8">
          <span className="text-xs text-muted-foreground">
            Showing {(safePage - 1) * itemsPerPage + 1}–
            {Math.min(safePage * itemsPerPage, totalItems)} of {totalItems} items
          </span>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
            >
              <ChevronLeft className="size-3.5" /> Previous
            </button>

            {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => (
              <button
                key={pageNum}
                type="button"
                onClick={() => setPage(pageNum)}
                className={`size-8 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  pageNum === safePage
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "border border-border bg-card text-ink hover:bg-muted/50"
                }`}
              >
                {pageNum}
              </button>
            ))}

            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => setPage(safePage + 1)}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
            >
              Next <ChevronRight className="size-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
