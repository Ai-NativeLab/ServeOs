import { formatMoney } from "@/lib/money";
import { arabicDescription } from "./bilingual";
import type { MenuProduct } from "./ProductCard";

export function FeaturedCard({ product, currency, interactive, onOpen }: {
  product: MenuProduct; currency: string; interactive: boolean; onOpen: () => void;
}) {
  const inStock = product.inStock;

  return (
    <button
      type="button"
      onClick={interactive && inStock ? onOpen : undefined}
      disabled={!interactive || !inStock}
      aria-label={!inStock ? `${product.nameEn} (Out of stock)` : interactive ? `Configure ${product.nameEn}` : product.nameEn}
      className="card-lift relative block h-44 w-full overflow-hidden rounded-2xl text-left disabled:opacity-100 sm:h-52"
    >
      {product.imageUrl
        ? /* eslint-disable-next-line @next/next/no-img-element */
          <img src={product.imageUrl} alt="" width={800} height={416} loading="lazy" className={`h-full w-full object-cover ${!inStock ? "opacity-40 grayscale" : ""}`} />
        : <div className="h-full w-full bg-secondary" />}
      <div className={`absolute inset-0 bg-gradient-to-r ${inStock ? "from-ink/85 via-ink/40 to-transparent" : "from-ink/95 via-ink/70 to-ink/40"}`} />
      <div className="absolute inset-y-0 left-0 flex max-w-[75%] flex-col justify-end p-4 sm:p-5">
        {!inStock ? (
          <span className="sf-badge-soft mb-2 self-start">Out of stock</span>
        ) : (
          <span className="sf-badge-soft mb-2 self-start">Featured</span>
        )}
        <h3 className="line-clamp-2 font-display text-xl font-bold text-white sm:text-2xl">{product.nameEn}</h3>
        {product.nameAr && <span dir="rtl" className="text-sm text-white/85">{product.nameAr}</span>}
        {product.descriptionEn && <p className="mt-1 line-clamp-2 text-xs text-white/85 sm:text-sm">{product.descriptionEn}</p>}
        {arabicDescription(product.descriptionEn, product.descriptionAr) && (
          <p dir="rtl" className="mt-0.5 line-clamp-2 text-xs text-white/85 sm:text-sm">
            {arabicDescription(product.descriptionEn, product.descriptionAr)}
          </p>
        )}
        <span className="mt-2 font-display text-lg font-bold text-white">{formatMoney(product.effectivePrice, currency)}</span>
      </div>
    </button>
  );
}
