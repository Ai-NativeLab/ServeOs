"use client";
import { useState } from "react";
import { Menu } from "lucide-react";
import { Dialog } from "radix-ui";
import { DashboardNav } from "./DashboardNav";
import type { NavItem } from "./nav-items";

export function MobileNav({ items, restaurantName }: { items: NavItem[]; restaurantName: string }) {
  const [open, setOpen] = useState(false);

  // The drawer closes on link click (via onNavigate below) and on Esc / backdrop
  // (handled by Radix Dialog), so no route-change effect is needed.
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label="Open menu"
        className="md:hidden inline-flex size-9 items-center justify-center rounded-md text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Menu className="size-5" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 md:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 w-72 max-w-[80vw] md:hidden shadow-xl outline-none"
        >
          <Dialog.Title className="sr-only">Navigation menu</Dialog.Title>
          <DashboardNav items={items} restaurantName={restaurantName} onNavigate={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
