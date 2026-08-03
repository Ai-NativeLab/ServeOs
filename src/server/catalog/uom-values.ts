/**
 * Pure UoM values and helpers — NO drizzle import. `uom.ts` builds the pg enum
 * from these same values; anything client-side (a storefront dimensional
 * product card) imports THIS module so a browser bundle never pulls in
 * drizzle-orm/pg-core just to check "is this UoM dimensional".
 */
export const UNIT_OF_MEASURE_VALUES = [
  "each", "g", "kg", "ml", "l", // ingredient/count units (Spec 8's domain)
  "m", "m2", "bf",              // dimensional/sellable units (P4's domain)
] as const;

export type UnitOfMeasure = (typeof UNIT_OF_MEASURE_VALUES)[number];

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
