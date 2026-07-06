import { DashboardNav } from "./DashboardNav";
import type { NavItem } from "./nav-items";

export function Sidebar({ items, restaurantName }: { items: NavItem[]; restaurantName: string }) {
  return (
    <aside className="hidden md:flex md:w-60 md:shrink-0 md:flex-col border-r border-sidebar-border">
      <DashboardNav items={items} restaurantName={restaurantName} />
    </aside>
  );
}
