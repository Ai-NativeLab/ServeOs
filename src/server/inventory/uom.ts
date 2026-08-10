import type { UnitOfMeasure } from "@/server/catalog/uom-values";
import { DimensionalUomError } from "./errors";

/**
 * The stockable SUBSET of the platform-wide `unit_of_measure` enum. That enum
 * also carries P4's sellable dimensional units (`m`/`m2`/`bf`), which are not
 * stockable — a pg enum cannot express a subset, so `assertInventoryUom` is the
 * boundary that keeps them out of the ledger. The `satisfies` turns a future
 * rename of the shared enum into a compile error here rather than silent drift.
 */
export const INVENTORY_UOMS = ["each", "g", "kg", "ml", "l"] as const satisfies readonly UnitOfMeasure[];
export type Uom = (typeof INVENTORY_UOMS)[number];
export type Dimension = "mass" | "volume" | "count";

/** Quantities carry 3 decimals (milligram/millilitre precision) — the `money(n)` analog. */
export const QTY_SCALE = 3;

const DIM: Record<Uom, Dimension> = { each: "count", g: "mass", kg: "mass", ml: "volume", l: "volume" };
/** Factor converting a value in `uom` into that dimension's canonical smallest unit. */
const TO_CANONICAL: Record<Uom, number> = { each: 1, g: 1, kg: 1000, ml: 1, l: 1000 };

/** Narrows a platform UoM to a stockable one, rejecting P4's sellable units. */
export function assertInventoryUom(u: UnitOfMeasure): Uom {
  if (!(INVENTORY_UOMS as readonly string[]).includes(u)) throw new DimensionalUomError(u, "a stockable unit");
  return u as Uom;
}

export function dimensionOf(uom: Uom): Dimension { return DIM[uom]; }

/**
 * Snaps a quantity to the module's scale. Every function here returns through
 * this, so binary-float artefacts (100 × 1.1 = 110.00000000000001) never leave
 * the module and never accumulate. That matters downstream: the FIFO deduction
 * loop compares a running remainder against an epsilon, and drift across
 * successive conversions could otherwise leave it never quite reaching zero.
 */
export function roundQty(n: number): number { return Math.round(n * 1000) / 1000; }

/** The single quantity formatter. Every numeric written to the ledger goes through it. */
export function qty(n: number): string { return roundQty(n).toFixed(QTY_SCALE); }

export function assertSameDimension(a: Uom, b: Uom): void {
  if (DIM[a] !== DIM[b]) throw new DimensionalUomError(a, b);
}

/**
 * Converts `value` expressed in `fromUom` into the item's base unit.
 *
 * With a `factorKind`, the item's own declared factor wins — that is how a
 * "24-can case" or "count in kg, hold in g" is expressed, and it is not
 * derivable dimensionally. Without one, the conversion is purely dimensional.
 * Either way the source dimension must be able to reach the base dimension.
 */
export function toBase(
  value: number, fromUom: Uom,
  item: { baseUom: Uom; stockToBase: string; purchaseToBase: string; recipeToBase: string },
  factorKind?: "stock" | "purchase" | "recipe",
): number {
  assertSameDimension(fromUom, item.baseUom);
  if (factorKind) {
    const f = { stock: item.stockToBase, purchase: item.purchaseToBase, recipe: item.recipeToBase }[factorKind];
    return roundQty(value * Number(f));
  }
  return roundQty((value * TO_CANONICAL[fromUom]) / TO_CANONICAL[item.baseUom]);
}

/** Yield loss: 100 g of onion at 10% waste consumes 110 g. */
export function withWaste(baseQty: number, wastePct: number): number { return roundQty(baseQty * (1 + wastePct / 100)); }

/**
 * A recipe yielding `yieldQty` units consumes each component pro rata for the
 * quantity actually sold. A zero yield is treated as one batch rather than
 * dividing by zero — a misconfigured recipe should still deduct something.
 */
export function scaleForYield(perBatch: number, soldQty: number, yieldQty: number): number {
  return roundQty(perBatch * (soldQty / (yieldQty || 1)));
}
