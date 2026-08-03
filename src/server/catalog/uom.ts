import { pgEnum } from "drizzle-orm/pg-core";

/**
 * ONE unit-of-measure enum for the whole platform (decision T1). Spec 8
 * (Inventory Core, #51 — not yet built) also needs a UoM concept for
 * ingredients; rather than two enums claiming the same idea, this superset
 * covers both domains. Spec 8 imports THIS enum when it lands — a build-order
 * accident (P4 shipped first), not P4 owning inventory. Spec 8 still owns the
 * ledger, lots and base/purchase/recipe conversion-factor machinery.
 */
export const unitOfMeasureEnum = pgEnum("unit_of_measure", [
  "each", "g", "kg", "ml", "l", // ingredient/count units (Spec 8's domain)
  "m", "m2", "bf",              // dimensional/sellable units (this spec's domain)
]);

export type UnitOfMeasure = (typeof unitOfMeasureEnum.enumValues)[number];

/** The dimensional subset — a product priced per one of these needs the
 *  customer to supply the matching dimensions before a price can exist. */
export const DIMENSIONAL_UOMS = ["m", "m2", "bf"] as const;
export type DimensionalUom = (typeof DIMENSIONAL_UOMS)[number];

export function isDimensionalUom(uom: UnitOfMeasure): uom is DimensionalUom {
  return (DIMENSIONAL_UOMS as readonly string[]).includes(uom);
}

export type DimensionField = "lengthMm" | "widthMm" | "thicknessMm";

/** Which dimension inputs a UoM's price formula needs, in entry order. */
export function requiredDimensions(uom: UnitOfMeasure): DimensionField[] {
  switch (uom) {
    case "m": return ["lengthMm"];
    case "m2": return ["lengthMm", "widthMm"];
    case "bf": return ["lengthMm", "widthMm", "thicknessMm"];
    default: return [];
  }
}
