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
              className="card-lift flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:border-primary"
            >
              <span className="font-sans font-semibold text-ink">{b.name}</span>
              <span
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                  b.open ? "bg-status-ready/15 text-status-ready-fg" : "bg-muted text-muted-foreground"
                }`}
              >
                <span className={`size-1.5 rounded-full ${b.open ? "bg-status-ready" : "bg-muted-foreground"}`} />
                {b.open ? "Open" : "Closed · pre-order"}
              </span>
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
