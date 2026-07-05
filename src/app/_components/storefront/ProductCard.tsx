"use client";
import type { PublishedMenu } from "@/server/catalog/schema";

export type MenuProduct = PublishedMenu["categories"][number]["products"][number];

export function ProductCard({
  product, interactive, onOpen,
}: {
  product: MenuProduct;
  interactive: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={interactive ? onOpen : undefined}
      disabled={!interactive}
      aria-label={interactive ? `Configure ${product.nameEn}` : product.nameEn}
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm transition-shadow hover:shadow-md disabled:cursor-default"
    >
      <div className="aspect-[4/3] w-full overflow-hidden bg-muted">
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt={product.nameEn}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-muted-foreground">No photo</div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <span className="font-sans font-semibold text-ink">{product.nameEn}</span>
        <span dir="rtl" className="text-sm text-muted-foreground">{product.nameAr}</span>
        <div className="mt-auto flex items-center justify-between pt-2">
          <span className="font-display font-bold text-ink">{product.effectivePrice.toFixed(2)}</span>
          {interactive && (
            <span className="inline-flex size-8 items-center justify-center rounded-full bg-primary text-lg leading-none text-primary-foreground">
              +
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
