import { requireSuperAdmin } from "@/server/auth/admin-context";
import { adminNavItems } from "@/components/admin/nav-items";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { AdminTopbar } from "@/components/admin/AdminTopbar";
import { Toaster } from "@/components/ui/sonner";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSuperAdmin();
  const items = adminNavItems();
  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <AdminSidebar items={items} adminName={user.name} />
      <div className="flex-1 flex flex-col min-w-0">
        <AdminTopbar userName={user.name} items={items} />
        <main className="flex-1 p-4 md:p-6 max-w-6xl w-full mx-auto">{children}</main>
      </div>
      <Toaster richColors position="top-right" />
    </div>
  );
}
