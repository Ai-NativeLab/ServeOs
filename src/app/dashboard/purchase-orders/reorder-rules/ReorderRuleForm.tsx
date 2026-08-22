"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { upsertReorderRuleAction, runReorderCheckAction } from "./actions";

export type ReorderItemOption = { id: string; nameEn: string; sku: string | null };
export type ReorderLocationOption = { id: string; name: string };
export type ReorderSupplierOption = { id: string; name: string };

const selectCls = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ReorderRuleHeaderActions({
  items,
  locations,
  suppliers,
}: {
  items: ReorderItemOption[];
  locations: ReorderLocationOption[];
  suppliers: ReorderSupplierOption[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [checking, startCheck] = useTransition();

  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [reorderPoint, setReorderPoint] = useState("5");
  const [reorderQty, setReorderQty] = useState("10");
  const [preferredSupplierId, setPreferredSupplierId] = useState("");

  function onOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      if (items.length > 0) setItemId(items[0].id);
      if (locations.length > 0) setLocationId(locations[0].id);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!itemId || !locationId) {
      toast.error("Item and Location are required");
      return;
    }
    const point = parseFloat(reorderPoint);
    const qty = parseFloat(reorderQty);
    if (isNaN(point) || point < 0) {
      toast.error("Reorder point must be 0 or greater");
      return;
    }
    if (isNaN(qty) || qty <= 0) {
      toast.error("Reorder quantity must be greater than 0");
      return;
    }

    startTransition(async () => {
      const res = await upsertReorderRuleAction({
        itemId,
        locationId,
        reorderPoint: point,
        reorderQty: qty,
        preferredSupplierId: preferredSupplierId || undefined,
      });

      if ("error" in res) {
        toast.error(res.error);
        return;
      }

      toast.success("Reorder rule saved");
      setOpen(false);
    });
  }

  function handleRunCheck() {
    startCheck(async () => {
      const res = await runReorderCheckAction();
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Sweep complete: ${res.triggered} low-stock alert(s), ${res.draftsCreated} draft PO(s) generated.`,
      );
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={handleRunCheck}
        disabled={checking}
      >
        <RefreshCw className={`size-4 mr-1.5 ${checking ? "animate-spin" : ""}`} />
        {checking ? "Checking stock..." : "Run check now"}
      </Button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild>
          <Button size="sm" disabled={items.length === 0 || locations.length === 0}>
            <Plus className="size-4 mr-1.5" /> Add rule
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={onSubmit}>
            <DialogHeader>
              <DialogTitle>Add reorder rule</DialogTitle>
              <DialogDescription>
                Automatically alert and draft POs when stock at a location drops below threshold.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="rule-item">Inventory item</Label>
                <select
                  id="rule-item"
                  value={itemId}
                  onChange={(e) => setItemId(e.target.value)}
                  required
                  className={selectCls}
                >
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.nameEn} {it.sku ? `(${it.sku})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="rule-location">Storage location</Label>
                <select
                  id="rule-location"
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  required
                  className={selectCls}
                >
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="rule-point">Reorder point (min)</Label>
                  <Input
                    id="rule-point"
                    type="number"
                    step="any"
                    min="0"
                    required
                    value={reorderPoint}
                    onChange={(e) => setReorderPoint(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="rule-qty">Reorder qty</Label>
                  <Input
                    id="rule-qty"
                    type="number"
                    step="any"
                    min="0.001"
                    required
                    value={reorderQty}
                    onChange={(e) => setReorderQty(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="rule-supplier">Preferred supplier (optional)</Label>
                <select
                  id="rule-supplier"
                  value={preferredSupplierId}
                  onChange={(e) => setPreferredSupplierId(e.target.value)}
                  className={selectCls}
                >
                  <option value="">No preferred supplier</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Save rule"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
