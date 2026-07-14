"use client";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { adminSignOutAction } from "@/app/admin/actions";
import type { NavItem } from "@/components/dashboard/nav-items";

export function AdminTopbar({ userName, items }: { userName: string; items: NavItem[] }) {
  return (
    <header className="h-14 flex items-center justify-between gap-3 border-b bg-card px-4">
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
            <DropdownMenuItem className="p-0">
              <form action={adminSignOutAction} className="w-full">
                <SubmitButton variant="ghost" className="w-full justify-start px-2 h-8 font-normal">
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
