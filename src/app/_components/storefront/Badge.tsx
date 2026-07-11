const LABELS = { popular: "Popular", new: "New", featured: "Featured" } as const;

export function Badge({ kind }: { kind: keyof typeof LABELS }) {
  return <span className={kind === "featured" ? "sf-badge-soft" : "sf-badge"}>{LABELS[kind]}</span>;
}
