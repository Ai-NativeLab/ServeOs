"use client";
import { Suspense, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Search } from "lucide-react";
import type { PublishedMenu } from "@/server/catalog/schema";
import type { MenuProduct } from "@/app/_components/storefront/ProductCard";
import { SectionHeader } from "@/app/_components/storefront/SectionHeader";
import { filterCatalog } from "./shop/shop-search";
import { ALL_CATEGORIES, catalogSearch, parseCatalogParams, type ParamSource } from "./catalog-pagination";

type Props = {
  menu: PublishedMenu;
  /** The request's query string from page.tsx, so a ?category= deep link is
   *  already drilled into on the server render (no flash of the root grid). */
  initialSearch: string;
  renderProductCard: (product: MenuProduct) => ReactNode;
  /** The category's featured product, when the template has a hero card for it. */
  renderFeaturedCard?: (product: MenuProduct) => ReactNode;
};

/** ?category= is the source of truth, derived on every render, so Back from
 *  a drilled-in category returns to the root grid. */
export function CategoryGridView(props: Props) {
  return (
    <Suspense fallback={<CategoryGrid {...props} params={new URLSearchParams(props.initialSearch)} />}>
      <CategoryGridFromUrl {...props} />
    </Suspense>
  );
}

function CategoryGridFromUrl(props: Props) {
  const params = useSearchParams();
  return <CategoryGrid {...props} params={params} />;
}

function CategoryGrid({ menu, renderProductCard, renderFeaturedCard, params }: Props & { params: ParamSource }) {
  const [searchQuery, setSearchQuery] = useState("");
  const categoryIds = menu.categories.map((c) => c.id);
  const { category } = parseCatalogParams(params, categoryIds);
  const selectedCategory = category === ALL_CATEGORIES ? null : menu.categories.find((c) => c.id === category) ?? null;

  const navigate = (catId: string) => {
    const search = catalogSearch(window.location.search, { category: catId, page: 1 });
    window.history.pushState(null, "", search || window.location.pathname);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Searching spans every category.
  const trimmed = searchQuery.trim();
  const isSearching = trimmed !== "";
  const filteredProducts = isSearching ? filterCatalog(menu.categories, trimmed).flatMap((c) => c.products) : [];

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
          className="w-full rounded-full border border-border bg-card px-4 py-2.5 ps-10 text-base text-ink outline-none transition-colors focus:border-primary/60 sm:text-sm"
        />
        <Search aria-hidden="true" className="absolute start-3.5 top-3 size-4 text-muted-foreground pointer-events-none" />
      </div>

      {isSearching ? (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-display font-bold text-ink">
              Search results for “{trimmed}” ({filteredProducts.length})
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
              No products found matching “{trimmed}”.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {filteredProducts.map((p) => renderProductCard(p))}
            </div>
          )}
        </div>
      ) : selectedCategory ? (
        /* Drilldown View: Single Category */
        <div>
          <button
            type="button"
            onClick={() => navigate(ALL_CATEGORIES)}
            className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:text-primary/80 transition-colors mb-4 cursor-pointer"
          >
            <ArrowLeft aria-hidden="true" className="size-4 rtl:rotate-180" strokeWidth={2} />
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
            const featured = renderFeaturedCard ? (selectedCategory.products.find((p) => p.isFeatured) ?? null) : null;
            const rest = selectedCategory.products.filter((p) => p.id !== featured?.id);
            return (
              <>
                {featured && renderFeaturedCard && <div className="mt-4">{renderFeaturedCard(featured)}</div>}
                <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  {rest.map((p) => renderProductCard(p))}
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
              <button
                key={cat.id}
                type="button"
                onClick={() => navigate(cat.id)}
                className="card-lift card-lift-hover group flex flex-col overflow-hidden rounded-2xl bg-card text-start cursor-pointer border border-border/70 transition-all hover:border-primary/40 shadow-xs"
              >
                <div className="relative aspect-[16/10] w-full overflow-hidden bg-muted">
                  {cat.imageUrl ? (
                    // Decorative: the category name is the button's text.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={cat.imageUrl}
                      alt=""
                      loading="lazy"
                      className="sf-img h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  ) : (
                    <div aria-hidden="true" className="flex h-full w-full items-center justify-center bg-primary/10 text-primary font-display font-bold text-2xl">
                      {cat.nameEn.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="absolute bottom-2 end-2 rounded-full bg-ink/80 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-xs">
                    {cat.products.length} {cat.products.length === 1 ? "item" : "items"}
                  </span>
                </div>

                <div className="flex flex-1 flex-col p-3.5 justify-between">
                  <div>
                    <span className="block font-sans text-sm font-bold text-ink group-hover:text-primary transition-colors">
                      {cat.nameEn}
                    </span>
                    {cat.nameAr && (
                      <span dir="rtl" className="block text-xs text-muted-foreground mt-0.5">
                        {cat.nameAr}
                      </span>
                    )}
                  </div>
                  <span aria-hidden="true" className="mt-2 text-xs font-semibold text-primary flex items-center gap-1">
                    Explore →
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
