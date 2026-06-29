import Link from "next/link";
import { Bell } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/app/dashboard/actions";
import { SubmitButton } from "./SubmitButton";

export function Topbar({ userName, roleLabel, pendingCount }: { userName: string; roleLabel: string; pendingCount: number }) {
  return (
    <header className="h-14 flex items-center justify-end gap-3 border-b bg-white px-4">
      <Button asChild variant="ghost" size="icon" className="relative">
        <Link href="/dashboard/orders" aria-label="Pending orders">
          <Bell className="size-5" />
          {pendingCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-primary text-[10px] leading-4 text-white text-center">
              {pendingCount}
            </span>
          )}
        </Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="gap-2">
            <span className="size-7 rounded-full bg-slate-200 grid place-items-center text-xs font-semibold">
              {userName.slice(0, 1).toUpperCase()}
            </span>
            <span className="text-sm">{userName}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="font-normal">
            <div className="text-sm font-medium">{userName}</div>
            <div className="text-xs text-muted-foreground">{roleLabel}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <form action={signOutAction}>
              <SubmitButton variant="ghost" className="w-full justify-start px-2 h-8 font-normal">Sign out</SubmitButton>
            </form>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
