"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { PackageCheck } from "lucide-react";
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
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { postReceiptAction, type ReceiveLinePayload } from "./actions";
import type { UnitOfMeasure } from "@/server/catalog/uom";

export type ReceiveDialogLine = {
  id: string;
  itemNameEn: string;
  qtyOrdered: number;
  qtyReceived: number;
  uom: UnitOfMeasure;
};

export function ReceiveStockDialog({
  poId,
  lines,
}: {
  poId: string;
  lines: ReceiveDialogLine[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [deliveryNote, setDeliveryNote] = useState("");
  const [expiryAt, setExpiryAt] = useState("");

  const [receivedQtys, setReceivedQtys] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const l of lines) {
      const remaining = Math.max(0, l.qtyOrdered - l.qtyReceived);
      init[l.id] = remaining;
    }
    return init;
  });

  function resetQtys() {
    const init: Record<string, number> = {};
    for (const l of lines) {
      init[l.id] = Math.max(0, l.qtyOrdered - l.qtyReceived);
    }
    setReceivedQtys(init);
    setDeliveryNote("");
    setExpiryAt("");
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      resetQtys();
    }
  }

  function updateQty(lineId: string, val: number) {
    setReceivedQtys((prev) => ({ ...prev, [lineId]: val }));
  }

  function handleReceiveAll() {
    const next: Record<string, number> = {};
    for (const l of lines) {
      next[l.id] = Math.max(0, l.qtyOrdered - l.qtyReceived);
    }
    setReceivedQtys(next);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payloadLines: ReceiveLinePayload[] = lines
      .filter((l) => (receivedQtys[l.id] ?? 0) > 0)
      .map((l) => ({
        poLineId: l.id,
        receivedQty: Number(receivedQtys[l.id]),
        uom: l.uom,
        expiryAt: expiryAt || null,
      }));

    if (payloadLines.length === 0) {
      toast.error("Enter at least one received quantity greater than 0");
      return;
    }

    startTransition(async () => {
      const res = await postReceiptAction(poId, {
        supplierDeliveryNote: deliveryNote || undefined,
        lines: payloadLines,
      });

      if ("error" in res) {
        toast.error(res.error);
        return;
      }

      toast.success("Stock received successfully and inventory lots updated");
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PackageCheck className="size-4 mr-1.5" /> Receive stock
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Receive stock</DialogTitle>
            <DialogDescription>
              Record delivered goods into inventory lots and increase on-hand stock.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="deliveryNote">Delivery note # (optional)</Label>
                <Input
                  id="deliveryNote"
                  placeholder="e.g. DN-9841"
                  value={deliveryNote}
                  onChange={(e) => setDeliveryNote(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="expiryAt">Lot expiry date (optional)</Label>
                <Input
                  id="expiryAt"
                  type="date"
                  value={expiryAt}
                  onChange={(e) => setExpiryAt(e.target.value)}
                />
              </div>
            </div>

            <div className="flex justify-between items-center pt-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Delivered quantities
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs h-7"
                onClick={handleReceiveAll}
              >
                Fill all remaining
              </Button>
            </div>

            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="eyebrow">Item</TableHead>
                    <TableHead className="eyebrow">Ordered</TableHead>
                    <TableHead className="eyebrow">Prev Received</TableHead>
                    <TableHead className="eyebrow w-36">Now Receiving</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => {
                    const remaining = Math.max(0, l.qtyOrdered - l.qtyReceived);
                    return (
                      <TableRow key={l.id}>
                        <TableCell className="font-medium text-sm">
                          {l.itemNameEn} <span className="uppercase text-xs text-muted-foreground">({l.uom})</span>
                        </TableCell>
                        <TableCell className="text-sm font-mono">{l.qtyOrdered}</TableCell>
                        <TableCell className="text-sm font-mono text-muted-foreground">{l.qtyReceived}</TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            step="any"
                            min="0"
                            value={receivedQtys[l.id] ?? 0}
                            onChange={(e) => updateQty(l.id, parseFloat(e.target.value) || 0)}
                            className="h-8 font-mono"
                            placeholder={String(remaining)}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
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
              {pending ? "Posting receipt..." : "Post receipt"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
