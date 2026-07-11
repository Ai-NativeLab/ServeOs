import { formatMoney } from "@/lib/money";
import type { MenuProduct } from "./ProductCard";

export function FeaturedCard({ product, currency, interactive, onOpen }: {
  product: MenuProduct; currency: string; interactive: boolean; onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={interactive ? onOpen : undefined}
      disabled={!interactive}
      aria-label={interactive ? `Configure ${product.nameEn}` : product.nameEn}
      className="card-lift relative block h-44 w-full overflow-hidden rounded-2xl text-left disabled:opacity-100 sm:h-52"
    >
      {product.imageUrl
        ? <img src={product.imageUrl} alt="" width={800} height={416} loading="lazy" className="h-full w-full object-cover" />
        : <div className="h-full w-full bg-secondary" />}
      <div className="absolute inset-0 bg-gradient-to-r from-ink/85 via-ink/40 to-transparent" />
      <div className="absolute inset-y-0 left-0 flex max-w-[75%] flex-col justify-end p-4 sm:p-5">
        <span className="sf-badge-soft mb-2 self-start">Featured</span>
        <h3 className="font-display text-xl font-bold text-white sm:text-2xl">{product.nameEn}</h3>
        {product.descriptionEn && <p className="mt-1 line-clamp-2 text-xs text-white/85 sm:text-sm">{product.descriptionEn}</p>}
        <span className="mt-2 font-display text-lg font-bold text-white">{formatMoney(product.effectivePrice, currency)}</span>
      </div>
    </button>
  );
}
