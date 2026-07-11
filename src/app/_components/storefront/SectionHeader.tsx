export function SectionHeader({ eyebrow, title, count }: { eyebrow?: string; title: string; count?: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 pb-1 pt-5">
      <div>
        {eyebrow && <div className="eyebrow text-muted-foreground">{eyebrow}</div>}
        <h2 className="font-display text-xl font-bold text-ink sm:text-2xl">{title}</h2>
      </div>
      {typeof count === "number" && (
        <span className="font-mono text-xs text-muted-foreground">{count} item{count === 1 ? "" : "s"}</span>
      )}
    </div>
  );
}
