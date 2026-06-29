"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Receipt, Utensils, Store, Image, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NavItem } from "./nav-items";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  home: Home, receipt: Receipt, utensils: Utensils, store: Store, image: Image, settings: Settings,
};

export function Sidebar({ items, restaurantName }: { items: NavItem[]; restaurantName: string }) {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex md:w-60 md:flex-col border-r bg-white">
      <div className="h-14 flex items-center gap-2 px-4 border-b">
        <div className="size-6 rounded bg-primary" />
        <span className="font-semibold">ServeOS</span>
      </div>
      <div className="px-4 py-3 text-sm text-muted-foreground truncate">{restaurantName}</div>
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
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
                active ? "bg-primary/10 text-primary" : "text-slate-600 hover:bg-slate-100",
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
