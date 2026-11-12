const LABELS = { popular: "Popular", new: "New", featured: "Featured", discount: "Sale" } as const;

export function Badge({ kind, label }: { kind: keyof typeof LABELS; label?: string }) {
  if (kind === "discount") {
    return <span className="sf-badge bg-destructive text-destructive-foreground font-bold shadow-sm">{label ?? LABELS.discount}</span>;
  }
  return <span className={kind === "featured" ? "sf-badge-soft" : "sf-badge"}>{label ?? LABELS[kind]}</span>;
}

/** "-20%" for a product with a live promotion, else null. Returns null (never
 * 0) so `{label && …}` can't render a stray "0". */
export function discountLabel(p: { hasDiscount: boolean; discountPercent: number | null }): string | null {
  return p.hasDiscount && (p.discountPercent ?? 0) > 0 ? `-${p.discountPercent}%` : null;
}
