"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { createDraftPoAction, type CreatePoLineData } from "../actions";
import type { UnitOfMeasure } from "@/server/catalog/uom";

export type FormSupplier = { id: string; name: string; isActive: boolean };
export type FormItem = { id: string; nameEn: string; baseUom: UnitOfMeasure; sku: string | null };

type LineState = {
  id: string; // client key
  itemId: string;
  qtyOrdered: number;
  uom: UnitOfMeasure;
  unitCost: number;
  taxRate: number; // 0.14
};

const selectCls = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function DraftPoForm({
  suppliers,
  items,
}: {
  suppliers: FormSupplier[];
  items: FormItem[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const activeSuppliers = suppliers.filter((s) => s.isActive);
  const [supplierId, setSupplierId] = useState(activeSuppliers[0]?.id ?? "");
  const [expectedAt, setExpectedAt] = useState("");
  const [lines, setLines] = useState<LineState[]>(() => {
    const firstItem = items[0];
    return firstItem
      ? [
          {
            id: crypto.randomUUID(),
            itemId: firstItem.id,
            qtyOrdered: 1,
            uom: firstItem.baseUom,
            unitCost: 0,
            taxRate: 0,
          },
        ]
      : [];
  });

  function addLine() {
    const firstItem = items[0];
    if (!firstItem) return;
    setLines((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        itemId: firstItem.id,
        qtyOrdered: 1,
        uom: firstItem.baseUom,
        unitCost: 0,
        taxRate: 0,
      },
    ]);
  }

  function removeLine(id: string) {
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.id !== id) : prev));
  }

  function updateLine(id: string, updates: Partial<LineState>) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const updated = { ...l, ...updates };
        if (updates.itemId) {
          const itemMatch = items.find((it) => it.id === updates.itemId);
          if (itemMatch) updated.uom = itemMatch.baseUom;
        }
        return updated;
      }),
    );
  }

  const grandTotal = lines.reduce(
    (acc, line) => acc + (line.qtyOrdered || 0) * (line.unitCost || 0) * (1 + (line.taxRate || 0)),
    0,
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supplierId) {
      toast.error("Please select a supplier");
      return;
    }
    if (lines.length === 0) {
      toast.error("Add at least one line item");
      return;
    }

    startTransition(async () => {
      const payloadLines: CreatePoLineData[] = lines.map((l) => ({
        itemId: l.itemId,
        qtyOrdered: Number(l.qtyOrdered),
        uom: l.uom,
        unitCost: Number(l.unitCost),
        taxRate: Number(l.taxRate) || undefined,
      }));

      const res = await createDraftPoAction({
        supplierId,
        expectedAt: expectedAt || null,
        lines: payloadLines,
      });

      if ("error" in res) {
        toast.error(res.error);
        return;
      }

      toast.success(`PO #${res.poNumber} created`);
      router.push(`/dashboard/purchase-orders/${res.poId}`);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card className="p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="supplierId">Supplier</Label>
            <select
              id="supplierId"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              required
              className={selectCls}
            >
              {activeSuppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {activeSuppliers.length === 0 && (
              <p className="text-xs text-destructive">No active suppliers found. Please add one first.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="expectedAt">Expected delivery date (optional)</Label>
            <Input
              id="expectedAt"
              type="date"
              value={expectedAt}
              onChange={(e) => setExpectedAt(e.target.value)}
            />
          </div>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-semibold text-sm">Line Items</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addLine}
            disabled={items.length === 0}
          >
            <Plus className="size-4 mr-1" /> Add item
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[35%]">Item</TableHead>
              <TableHead className="w-[15%]">Qty</TableHead>
              <TableHead className="w-[15%]">Unit</TableHead>
              <TableHead className="w-[15%]">Unit Cost</TableHead>
              <TableHead className="w-[10%]">Tax Rate</TableHead>
              <TableHead className="w-[10%] text-right">Subtotal</TableHead>
              <TableHead className="w-[5%]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line, idx) => {
              const lineSubtotal =
                (line.qtyOrdered || 0) * (line.unitCost || 0) * (1 + (line.taxRate || 0));
              return (
                <TableRow key={line.id}>
                  <TableCell>
                    <select
                      value={line.itemId}
                      onChange={(e) => updateLine(line.id, { itemId: e.target.value })}
                      required
                      className={selectCls}
                    >
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.nameEn} {it.sku ? `(${it.sku})` : ""}
                        </option>
                      ))}
                    </select>
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      step="any"
                      min="0.001"
                      required
                      value={line.qtyOrdered}
                      onChange={(e) => updateLine(line.id, { qtyOrdered: parseFloat(e.target.value) || 0 })}
                    />
                  </TableCell>
                  <TableCell>
                    <span className="text-sm font-medium uppercase text-muted-foreground">{line.uom}</span>
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      required
                      value={line.unitCost}
                      onChange={(e) => updateLine(line.id, { unitCost: parseFloat(e.target.value) || 0 })}
                    />
                  </TableCell>
                  <TableCell>
                    <select
                      value={line.taxRate}
                      onChange={(e) => updateLine(line.id, { taxRate: parseFloat(e.target.value) || 0 })}
                      className={selectCls}
                    >
                      <option value="0">0%</option>
                      <option value="0.14">14% (VAT)</option>
                    </select>
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {lineSubtotal.toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeLine(line.id)}
                      disabled={lines.length <= 1}
                      aria-label={`Remove line ${idx + 1}`}
                    >
                      <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        <div className="p-4 border-t bg-muted/30 flex items-center justify-between">
          <span className="text-sm font-semibold">Total Amount</span>
          <span className="text-lg font-bold font-mono">
            {grandTotal.toFixed(2)} EGP
          </span>
        </div>
      </Card>

      <div className="flex justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push("/dashboard/purchase-orders")}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending || activeSuppliers.length === 0}>
          {pending ? "Saving..." : "Save draft PO"}
        </Button>
      </div>
    </form>
  );
}
