import { AdminNav } from "./AdminNav";
import type { NavItem } from "@/components/dashboard/nav-items";

export function AdminSidebar({ items, adminName }: { items: NavItem[]; adminName: string }) {
  return (
    <aside className="hidden md:flex md:w-60 md:shrink-0 md:flex-col border-r border-sidebar-border">
      <AdminNav items={items} adminName={adminName} />
    </aside>
  );
}
