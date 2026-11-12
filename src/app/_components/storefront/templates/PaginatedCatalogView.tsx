"use client";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import type { PublishedMenu } from "@/server/catalog/schema";
import type { MenuProduct } from "@/app/_components/storefront/ProductCard";
import { filterCatalog } from "./shop/shop-search";
import {
  ALL_CATEGORIES, catalogSearch, clampPage, pageSlice, paginationWindow, parseCatalogParams, totalPagesFor,
  type ParamSource,
} from "./catalog-pagination";

type Props = {
  menu: PublishedMenu;
  itemsPerPage: number;
  /** The request's query string from page.tsx, so the server render (and the
   *  Suspense fallback) already shows the deep-linked category/page. */
  initialSearch: string;
  renderProductCard: (product: MenuProduct) => ReactNode;
};

/** ?category= and ?page= are the source of truth: the view derives its state
 *  from them on every render, so Back/Forward and deep links just work. */
export function PaginatedCatalogView(props: Props) {
  return (
    <Suspense fallback={<PaginatedCatalog {...props} params={new URLSearchParams(props.initialSearch)} />}>
      <PaginatedCatalogFromUrl {...props} />
    </Suspense>
  );
}

function PaginatedCatalogFromUrl(props: Props) {
  const params = useSearchParams();
  return <PaginatedCatalog {...props} params={params} />;
}

function go(search: string, mode: "push" | "replace") {
  const url = search || window.location.pathname;
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

function PaginatedCatalog({ menu, itemsPerPage, renderProductCard, params }: Props & { params: ParamSource }) {
  const [searchQuery, setSearchQuery] = useState("");
  const categoryIds = menu.categories.map((c) => c.id);
  const { category, page: requestedPage, pageWasInvalid } = parseCatalogParams(params, categoryIds);

  const scoped = category === ALL_CATEGORIES ? menu.categories : menu.categories.filter((c) => c.id === category);
  const filteredProducts = filterCatalog(scoped, searchQuery).flatMap((c) => c.products);

  const totalItems = filteredProducts.length;
  const totalPages = totalPagesFor(totalItems, itemsPerPage);
  const page = clampPage(requestedPage, totalPages);
  const pagedProducts = pageSlice(filteredProducts, page, itemsPerPage);
  const isSearching = searchQuery.trim() !== "";

  // ?page=2.5 / ?page=99: show the clamped page AND put the canonical value
  // back in the address bar (replace, so Back doesn't return to the bad URL).
  // Skipped while searching: a search shrinks the list without touching the URL.
  useEffect(() => {
    if (isSearching) return;
    if (pageWasInvalid || page !== requestedPage) {
      go(catalogSearch(window.location.search, { page }), "replace");
    }
  }, [isSearching, pageWasInvalid, page, requestedPage]);

  const setPage = (pageNumber: number) => {
    go(catalogSearch(window.location.search, { page: pageNumber }), "push");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const setCategoryFilter = (catId: string) => {
    go(catalogSearch(window.location.search, { category: catId, page: 1 }), "push");
  };

  const totalAllProducts = menu.categories.reduce((s, c) => s + c.products.length, 0);

  const pillClass = (selected: boolean) =>
    `shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition-all cursor-pointer ${
      selected
        ? "bg-primary text-primary-foreground shadow-xs"
        : "border border-border bg-card text-muted-foreground hover:bg-muted/50"
    }`;

  return (
    <div className="py-4 space-y-6">
      {/* Search Bar */}
      <div className="relative">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            // A new search starts from the first page of its results.
            if (requestedPage !== 1) go(catalogSearch(window.location.search, { page: 1 }), "replace");
          }}
          placeholder="Search products or brands / ابحث عن المنتجات…"
          aria-label="Search catalog"
          className="w-full rounded-full border border-border bg-card px-4 py-2.5 ps-10 text-base text-ink outline-none transition-colors focus:border-primary/60 sm:text-sm"
        />
        <Search aria-hidden="true" className="absolute start-3.5 top-3 size-4 text-muted-foreground pointer-events-none" />
      </div>

      {/* Category Filter Pills (Horizontal Scrollable) */}
      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none" role="group" aria-label="Filter by category">
        <button
          type="button"
          aria-pressed={category === ALL_CATEGORIES}
          onClick={() => setCategoryFilter(ALL_CATEGORIES)}
          className={pillClass(category === ALL_CATEGORIES)}
        >
          All Items ({totalAllProducts})
        </button>
        {menu.categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            aria-pressed={category === cat.id}
            onClick={() => setCategoryFilter(cat.id)}
            className={pillClass(category === cat.id)}
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
          {pagedProducts.map((p) => renderProductCard(p))}
        </div>
      )}

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <nav
          aria-label="Catalog pages"
          className="flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-border pt-6 mt-8"
        >
          <span className="text-xs text-muted-foreground">
            Showing {(page - 1) * itemsPerPage + 1}–
            {Math.min(page * itemsPerPage, totalItems)} of {totalItems} items
          </span>

          <div className="flex flex-wrap items-center justify-center gap-1.5">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
            >
              <ChevronLeft aria-hidden="true" className="size-3.5 rtl:rotate-180" /> Previous
            </button>

            {paginationWindow(page, totalPages).map((token) =>
              typeof token === "number" ? (
                <button
                  key={token}
                  type="button"
                  onClick={() => setPage(token)}
                  aria-current={token === page ? "page" : undefined}
                  aria-label={`Page ${token}`}
                  className={`size-8 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    token === page
                      ? "bg-primary text-primary-foreground shadow-xs"
                      : "border border-border bg-card text-ink hover:bg-muted/50"
                  }`}
                >
                  {token}
                </button>
              ) : (
                <span key={token} aria-hidden="true" className="px-1 text-xs text-muted-foreground">
                  …
                </span>
              ),
            )}

            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
            >
              Next <ChevronRight aria-hidden="true" className="size-3.5 rtl:rotate-180" />
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
