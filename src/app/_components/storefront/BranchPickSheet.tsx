"use client";
import { useRouter } from "next/navigation";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";

export function BranchPickSheet({
  branches, open, onOpenChange, productId,
}: {
  branches: { id: string; name: string; open: boolean }[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  productId: string | null;
}) {
  const router = useRouter();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Choose a branch</SheetTitle>
          <SheetDescription>Prices and availability can differ per branch.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 flex flex-col gap-2">
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                const params = new URLSearchParams(window.location.search);
                params.set("branch", b.id);
                if (productId) params.set("product", productId);
                router.push(`?${params.toString()}`);
                onOpenChange(false);
              }}
              className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary"
            >
              <span className="font-sans font-semibold text-ink">{b.name}</span>
              <span className={`text-xs font-medium ${b.open ? "text-status-ready-fg" : "text-muted-foreground"}`}>
                {b.open ? "Open" : "Closed · pre-order"}
              </span>
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
