import type { ReactNode } from "react";

export function PageHeader({
  title, description, eyebrow, action,
}: { title: string; description?: string; eyebrow?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        {eyebrow && <div className="eyebrow text-primary mb-1.5">{eyebrow}</div>}
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
