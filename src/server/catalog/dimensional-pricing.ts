import { requiredDimensions, type DimensionalUom, type DimensionField } from "./uom-values";

export type Dimensions = { lengthMm?: number; widthMm?: number; thicknessMm?: number };

export class MissingDimensionError extends Error {
  constructor(field: DimensionField) { super(`missing required dimension: ${field}`); }
}

const MM_PER_INCH = 25.4;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Dimensional quantities (m/m²/bf) need finer precision than money — a small
 *  rounding at this stage compounds visibly once multiplied by a unit price. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function need(dims: Dimensions, uom: DimensionalUom): Required<Dimensions> {
  const out: Record<string, number> = {};
  for (const field of requiredDimensions(uom)) {
    const value = dims[field];
    if (value === undefined) throw new MissingDimensionError(field);
    if (!(value > 0)) throw new Error(`${field} must be a positive number`);
    out[field] = value;
  }
  return out as Required<Dimensions>;
}

/**
 * The quantity a dimensional product line represents, IN ITS OWN UoM.
 * Dimension inputs are always millimeters (the metric baseline — Egypt is a
 * metric country even for a "board ft" product), converted per formula.
 */
export function computeDimensionalQuantity(uom: DimensionalUom, dims: Dimensions): number {
  if (uom === "m") {
    const { lengthMm } = need(dims, uom);
    return round3(lengthMm / 1000);
  }
  if (uom === "m2") {
    const { lengthMm, widthMm } = need(dims, uom);
    return round3((lengthMm / 1000) * (widthMm / 1000));
  }
  // Board foot: the standard lumber definition — a board 1" thick, 12" wide,
  // 1' long. bf = (thickness_in * width_in * length_in) / 144.
  const { lengthMm, widthMm, thicknessMm } = need(dims, uom);
  const [lengthIn, widthIn, thicknessIn] = [lengthMm, widthMm, thicknessMm].map((mm) => mm / MM_PER_INCH);
  return round3((thicknessIn * widthIn * lengthIn) / 144);
}

/** basePrice (price per unit of measure, decision T2) x the computed quantity
 *  — the resulting number is a normal unitPrice from here on, feeding the
 *  UNCHANGED computeLineTotal/computeCartTotals pipeline. */
export function computeDimensionalUnitPrice(pricePerUnit: number, uom: DimensionalUom, dims: Dimensions): number {
  return round2(pricePerUnit * computeDimensionalQuantity(uom, dims));
}
