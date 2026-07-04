import type { ReactNode } from "react";
import { LogoMark } from "@/components/brand/LogoMark";

export function EmptyState({
  title, description, action,
}: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed bg-card py-16 px-6 text-center">
      <LogoMark className="size-10 text-muted-foreground/40 mb-4" />
      <h3 className="font-display text-lg font-bold text-ink">{title}</h3>
      {description && <p className="text-sm text-muted-foreground mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
