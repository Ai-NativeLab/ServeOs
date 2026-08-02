import Link from "next/link";
import { Button } from "@/components/ui/button";
import { RANGES } from "./range";

const SECTIONS = [
  { href: "/dashboard/analytics", label: "Overview" },
  { href: "/dashboard/analytics/sales", label: "Sales" },
  { href: "/dashboard/analytics/financial", label: "Financial" },
  { href: "/dashboard/analytics/inventory", label: "Inventory" },
  { href: "/dashboard/analytics/purchasing", label: "Purchasing" },
] as const;

/** Section links + range switcher for every analytics page's header action row. */
export function ReportsNav({ current, days }: { current: string; days: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {SECTIONS.map((s) => (
        <Button key={s.href} asChild variant={s.href === current ? "secondary" : "ghost"} size="sm">
          <Link href={`${s.href}?range=${days}`}>{s.label}</Link>
        </Button>
      ))}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      {RANGES.map((r) => (
        <Button key={r} asChild variant={r === String(days) ? "default" : "outline"} size="sm">
          <Link href={`${current}?range=${r}`}>{r}d</Link>
        </Button>
      ))}
    </div>
  );
}
