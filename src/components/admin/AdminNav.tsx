"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, ClipboardList, Store, ScrollText, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/brand/LogoMark";
import type { NavItem } from "@/components/dashboard/nav-items";

const ICONS: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  overview: LayoutDashboard,
  approvals: ClipboardList,
  billing: CreditCard,
  tenants: Store,
  audit: ScrollText,
};

export function AdminNav({ items, adminName }: { items: NavItem[]; adminName: string }) {
  const pathname = usePathname();
  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="h-16 flex items-center gap-3 px-4">
        <div className="size-9 rounded-lg bg-sidebar-primary grid place-items-center shrink-0">
          <LogoMark className="size-6 text-sidebar-primary-foreground" />
        </div>
        <span className="font-display text-lg font-bold tracking-tight">
          Serve<span className="text-sidebar-accent-foreground">OS</span>
        </span>
      </div>
      <div className="eyebrow px-4 pb-4 text-sidebar-foreground/50 truncate">{adminName}</div>
      <nav className="flex-1 px-2 space-y-1 overflow-y-auto">
        {items.map((item) => {
          const Icon = ICONS[item.icon] ?? LayoutDashboard;
          const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-white/5 hover:text-sidebar-foreground",
              )}
            >
              <Icon className="size-4" strokeWidth={1.5} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
