"use client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { adminSignOutAction } from "@/app/admin/actions";
import { AdminMobileNav } from "./AdminMobileNav";
import type { NavItem } from "@/components/dashboard/nav-items";
export function AdminTopbar({
  userName,
  items,
}: {
  userName: string;
  items: NavItem[];
}) {
  return (
    <header className="h-14 flex items-center justify-between gap-3 border-b bg-card px-4">
      <div className="flex items-center gap-2 md:hidden">
        <AdminMobileNav items={items} adminName={userName} />
        <span className="font-display text-base font-bold tracking-tight">
          Serve<span className="text-primary">OS</span>
        </span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2">
              <span className="size-7 rounded-full bg-secondary text-ink grid place-items-center text-xs font-semibold">
                {userName.slice(0, 1).toUpperCase()}
              </span>
              <span className="text-sm">{userName}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="font-normal">
              <div className="text-sm font-medium">{userName}</div>
              <div className="text-xs text-muted-foreground">Super admin</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* Same fix as the tenant Topbar: without this, selecting the item
                closes the menu and unmounts the form before it can submit, so
                sign-out silently does nothing. */}
            <DropdownMenuItem className="p-0" onSelect={(e) => e.preventDefault()}>
              <form action={adminSignOutAction} className="w-full">
                <SubmitButton
                  variant="ghost"
                  className="w-full justify-start px-2 h-8 font-normal"
                >
                  Sign out
                </SubmitButton>
              </form>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
