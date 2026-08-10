"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { setRecipeComponentsAction } from "../../actions";

type Item = { id: string; nameEn: string; baseUom: string };
type Row = { itemId: string; qty: string; uom: string; wastePct: string };

const selectCls = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const UOMS = ["each", "g", "kg", "ml", "l"];

/**
 * Edits a bill of materials as a whole list — the form posts every row and the
 * server swaps them. A BOM is read and reasoned about as one thing ("what goes
 * into this dish"), so diffing individual lines would add bookkeeping without
 * matching how anyone actually edits it.
 */
export function RecipeComponentsEditor({ recipeId, items, components }: {
  recipeId: string; items: Item[]; components: Row[];
}) {
  const blank = (): Row => ({ itemId: items[0]?.id ?? "", qty: "", uom: items[0]?.baseUom ?? "g", wastePct: "0" });
  const [rows, setRows] = useState<Row[]>(components.length > 0 ? components : [blank()]);

  const update = (i: number, patch: Partial<Row>) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  return (
    <ToastForm
      action={setRecipeComponentsAction.bind(null, recipeId)}
      successMessage="Ingredients saved"
      className="space-y-3"
    >
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-[1fr_5rem_5rem_5rem_2rem] gap-2 items-end">
            <div>
              {i === 0 && <label className="eyebrow block mb-1.5">Ingredient</label>}
              <select
                name="componentItemId"
                className={selectCls}
                value={row.itemId}
                onChange={(e) => {
                  const item = items.find((it) => it.id === e.target.value);
                  // Default the unit to the ingredient's own, which is the common case
                  // and the only one guaranteed to convert.
                  update(i, { itemId: e.target.value, uom: item?.baseUom ?? row.uom });
                }}
              >
                {items.map((it) => <option key={it.id} value={it.id}>{it.nameEn}</option>)}
              </select>
            </div>
            <div>
              {i === 0 && <label className="eyebrow block mb-1.5">Qty</label>}
              <Input
                name="componentQty" type="number" step="0.001" min="0" required
                value={row.qty} onChange={(e) => update(i, { qty: e.target.value })}
              />
            </div>
            <div>
              {i === 0 && <label className="eyebrow block mb-1.5">Unit</label>}
              <select name="componentUom" className={selectCls} value={row.uom}
                onChange={(e) => update(i, { uom: e.target.value })}>
                {UOMS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div>
              {i === 0 && <label className="eyebrow block mb-1.5">Waste %</label>}
              <Input
                name="componentWastePct" type="number" step="0.1" min="0"
                value={row.wastePct} onChange={(e) => update(i, { wastePct: e.target.value })}
              />
            </div>
            <Button
              type="button" variant="ghost" size="sm" aria-label="Remove ingredient"
              onClick={() => setRows((r) => (r.length === 1 ? [blank()] : r.filter((_, idx) => idx !== i)))}
            >
              ×
            </Button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setRows((r) => [...r, blank()])}>
          Add ingredient
        </Button>
        <SubmitButton size="sm">Save ingredients</SubmitButton>
      </div>
    </ToastForm>
  );
}
