"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger,
} from "@/components/ui/dialog";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { receiveStockAction, adjustStockAction, transferStockAction } from "./actions";

type Item = { id: string; nameEn: string; baseUom: string };
type Location = { id: string; name: string; kind: string };

const selectCls =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

/**
 * The three stock movements an operator performs from the on-hand table.
 *
 * Receiving is separated from adjusting on purpose. A delivery and a correction
 * are different events — one creates a cost-carrying lot, the other reconciles a
 * number — and collapsing them into "change the quantity" is what made the flat
 * integer counter unauditable in the first place.
 */
export function StockMovementForms({ item, locations, branchId }: {
  item: Item; locations: Location[]; branchId: string;
}) {
  const [open, setOpen] = useState<"receive" | "adjust" | "transfer" | null>(null);
  const close = () => setOpen(null);

  const locationSelect = (name: string, label: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${name}-${item.id}`}>{label}</Label>
      <select id={`${name}-${item.id}`} name={name} className={selectCls} defaultValue={locations[0]?.id ?? ""}>
        {locations.length === 0 && <option value="">Branch default</option>}
        {locations.map((l) => (
          <option key={l.id} value={l.id}>{l.name} · {l.kind.replace(/_/g, " ")}</option>
        ))}
      </select>
    </div>
  );

  const qtyRow = (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor={`qty-${item.id}`}>Quantity</Label>
        <Input id={`qty-${item.id}`} name="qty" type="number" step="0.001" required autoFocus />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`uom-${item.id}`}>Unit</Label>
        {/* Defaults to the item's base unit; anything convertible is accepted and
            normalised server-side, so "2 kg" of a gram item books 2000 g. */}
        <select id={`uom-${item.id}`} name="uom" className={selectCls} defaultValue={item.baseUom}>
          {["each", "g", "kg", "ml", "l"].map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
    </div>
  );

  return (
    <div className="flex justify-end gap-1.5">
      <Dialog open={open === "receive"} onOpenChange={(o) => setOpen(o ? "receive" : null)}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">Receive</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Receive stock — {item.nameEn}</DialogTitle>
            <DialogDescription>
              Books a delivery as a new lot, so it is immediately sellable and carries its own cost.
            </DialogDescription>
          </DialogHeader>
          <ToastForm action={receiveStockAction} successMessage="Stock received" onSuccess={close} className="space-y-3">
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="branchId" value={branchId} />
            {qtyRow}
            {locationSelect("locationId", "Location")}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`cost-${item.id}`}>Unit cost</Label>
                <Input id={`cost-${item.id}`} name="unitCost" type="number" step="0.01" placeholder="0.00" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`exp-${item.id}`}>Expires</Label>
                {/* Expired lots are excluded from sale, so this is what keeps
                    perishable stock from going out of the door late. */}
                <Input id={`exp-${item.id}`} name="expiryAt" type="date" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`lot-${item.id}`}>Lot code</Label>
                <Input id={`lot-${item.id}`} name="lotCode" placeholder="Batch reference" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`len-${item.id}`}>Length (mm)</Label>
                {/* Cut-to-size stock only. A cut consumes one piece of this
                    length and books the remainder back as a sellable offcut. */}
                <Input id={`len-${item.id}`} name="lengthMm" type="number" min="1" placeholder="e.g. 6000" />
              </div>
            </div>
            <SubmitButton className="w-full">Receive</SubmitButton>
          </ToastForm>
        </DialogContent>
      </Dialog>

      <Dialog open={open === "adjust"} onOpenChange={(o) => setOpen(o ? "adjust" : null)}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm">Adjust</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust or write off — {item.nameEn}</DialogTitle>
            <DialogDescription>
              A correction can be positive or negative. Waste is recorded as its own movement so
              shrinkage stays reportable instead of looking like a recount.
            </DialogDescription>
          </DialogHeader>
          <ToastForm action={adjustStockAction} successMessage="Stock adjusted" onSuccess={close} className="space-y-3">
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="branchId" value={branchId} />
            <div className="space-y-1.5">
              <Label htmlFor={`mode-${item.id}`}>Movement</Label>
              <select id={`mode-${item.id}`} name="mode" className={selectCls} defaultValue="adjustment">
                <option value="adjustment">Correction (+/−)</option>
                <option value="waste">Waste / write-off</option>
              </select>
            </div>
            {qtyRow}
            {locationSelect("locationId", "Location")}
            <div className="space-y-1.5">
              <Label htmlFor={`note-${item.id}`}>Reason</Label>
              <Input id={`note-${item.id}`} name="note" placeholder="Spillage, recount, damage…" />
            </div>
            <SubmitButton className="w-full">Save movement</SubmitButton>
          </ToastForm>
        </DialogContent>
      </Dialog>

      {locations.length > 1 && (
        <Dialog open={open === "transfer"} onOpenChange={(o) => setOpen(o ? "transfer" : null)}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm">Move</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Move stock — {item.nameEn}</DialogTitle>
              <DialogDescription>
                Moves the lots as well as the number, so the destination can actually sell what arrives.
              </DialogDescription>
            </DialogHeader>
            <ToastForm action={transferStockAction} successMessage="Stock moved" onSuccess={close} className="space-y-3">
              <input type="hidden" name="itemId" value={item.id} />
              {qtyRow}
              {locationSelect("fromLocationId", "From")}
              {locationSelect("toLocationId", "To")}
              <SubmitButton className="w-full">Move</SubmitButton>
            </ToastForm>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
