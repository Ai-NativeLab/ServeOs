"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Receipt, Utensils, Store, Image, Settings, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/brand/LogoMark";
import type { NavItem } from "./nav-items";

const ICONS: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  home: Home, analytics: BarChart3, receipt: Receipt, utensils: Utensils, store: Store, image: Image, settings: Settings,
};

export function Sidebar({ items, restaurantName }: { items: NavItem[]; restaurantName: string }) {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex md:w-60 md:flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
      <div className="h-16 flex items-center gap-3 px-4">
        <div className="size-9 rounded-lg bg-sidebar-primary grid place-items-center shrink-0">
          <LogoMark className="size-6 text-sidebar-primary-foreground" />
        </div>
        <span className="font-display text-lg font-bold tracking-tight">
          Serve<span className="text-sidebar-accent-foreground">OS</span>
        </span>
      </div>
      <div className="eyebrow px-4 pb-4 text-sidebar-foreground/50 truncate">{restaurantName}</div>
      <nav className="flex-1 px-2 space-y-1">
        {items.map((item) => {
          const Icon = ICONS[item.icon] ?? Home;
          const active = item.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(item.href);
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
    </aside>
  );
}
