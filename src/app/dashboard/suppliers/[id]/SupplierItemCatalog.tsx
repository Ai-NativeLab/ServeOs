"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { upsertSupplierItemAction } from "../actions";
import { formatUnitRate } from "@/server/purchasing/amounts";
import type { SupplierItemWithDetails } from "@/server/purchasing/suppliers";
import type { UnitOfMeasure } from "@/server/catalog/uom";

export type AvailableItem = {
  id: string;
  nameEn: string;
  baseUom: UnitOfMeasure;
  sku: string | null;
};

const selectCls = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SupplierItemCatalog({
  supplierId,
  supplierItems,
  availableItems,
}: {
  supplierId: string;
  supplierItems: SupplierItemWithDetails[];
  availableItems: AvailableItem[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [itemId, setItemId] = useState(availableItems[0]?.id ?? "");
  const [supplierSku, setSupplierSku] = useState("");
  const [lastUnitCost, setLastUnitCost] = useState("");
  const [packUom, setPackUom] = useState<UnitOfMeasure>("each");

  function onOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen && availableItems.length > 0) {
      setItemId(availableItems[0]?.id ?? "");
      setPackUom(availableItems[0]?.baseUom ?? "each");
      setSupplierSku("");
      setLastUnitCost("");
    }
  }

  function handleItemChange(newItemId: string) {
    setItemId(newItemId);
    const it = availableItems.find((x) => x.id === newItemId);
    if (it) setPackUom(it.baseUom);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!itemId) {
      toast.error("Please pick an inventory item");
      return;
    }

    startTransition(async () => {
      const res = await upsertSupplierItemAction(supplierId, {
        itemId,
        supplierSku: supplierSku.trim() || null,
        lastUnitCost: lastUnitCost ? parseFloat(lastUnitCost) : undefined,
        packUom,
      });

      if ("error" in res) {
        toast.error(res.error);
        return;
      }

      toast.success("Supplier catalog updated");
      setOpen(false);
    });
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="p-4 border-b flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-sm">Supplier Item Catalog ({supplierItems.length})</h2>
          <p className="text-xs text-muted-foreground">
            Items this vendor supplies, including vendor SKUs and contracted unit pricing.
          </p>
        </div>

        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" disabled={availableItems.length === 0}>
              <Plus className="size-4 mr-1.5" /> Map item
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <form onSubmit={onSubmit}>
              <DialogHeader>
                <DialogTitle>Map supplier item</DialogTitle>
                <DialogDescription>
                  Link an inventory item to this vendor with vendor-specific SKU and pricing.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="space-y-1.5">
                  <Label htmlFor="item-select">Inventory item</Label>
                  <select
                    id="item-select"
                    value={itemId}
                    onChange={(e) => handleItemChange(e.target.value)}
                    required
                    className={selectCls}
                  >
                    {availableItems.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.nameEn} {it.sku ? `(${it.sku})` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="supplierSku">Supplier SKU / part # (optional)</Label>
                  <Input
                    id="supplierSku"
                    value={supplierSku}
                    onChange={(e) => setSupplierSku(e.target.value)}
                    placeholder="e.g. VEND-TOM-01"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="lastUnitCost">Contract / Unit Cost</Label>
                    <Input
                      id="lastUnitCost"
                      type="number"
                      step="any"
                      min="0"
                      value={lastUnitCost}
                      onChange={(e) => setLastUnitCost(e.target.value)}
                      placeholder="0.00"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="packUom">Pack Unit</Label>
                    <select
                      id="packUom"
                      value={packUom}
                      onChange={(e) => setPackUom(e.target.value as UnitOfMeasure)}
                      className={selectCls}
                    >
                      <option value="each">each</option>
                      <option value="kg">kg</option>
                      <option value="g">g</option>
                      <option value="l">l</option>
                      <option value="ml">ml</option>
                    </select>
                  </div>
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
                  {pending ? "Saving..." : "Save item mapping"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {supplierItems.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          No inventory items mapped to this supplier yet. Map items above to speed up PO drafting.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="eyebrow">Item</TableHead>
              <TableHead className="eyebrow">Supplier SKU</TableHead>
              <TableHead className="eyebrow">Pack Unit</TableHead>
              <TableHead className="eyebrow">Last / Contract Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {supplierItems.map((si) => (
              <TableRow key={si.id}>
                <TableCell className="font-medium">{si.itemNameEn ?? "—"}</TableCell>
                <TableCell className="font-mono text-muted-foreground">{si.supplierSku ?? "—"}</TableCell>
                <TableCell className="uppercase text-muted-foreground">{si.packUom ?? "each"}</TableCell>
                <TableCell className="font-mono">
                  {si.lastUnitCost ? `${formatUnitRate(si.lastUnitCost)} EGP` : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
