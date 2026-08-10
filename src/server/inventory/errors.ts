import { DomainError, type Locale } from "@/shared/errors";

// A retail shortfall reuses the existing typed error rather than declaring a
// parallel one, so retail's failure surface stays byte-identical to the flat
// integer counter it replaces.
export { OutOfStockError } from "@/server/ordering/errors";

/**
 * Raised when a quantity cannot be converted: either across dimensions
 * (`g` → `ml`, since density is not modelled) or from a unit that is not
 * stockable at all (P4's sellable `m`/`m2`/`bf` live in the same platform enum).
 */
export class DimensionalUomError extends DomainError {
  readonly code = "dimensional_uom";
  constructor(readonly from: string, readonly to: string) {
    super(`Cannot convert ${from} to ${to}: different dimensions`);
    this.name = "DimensionalUomError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "لا يمكن تحويل وحدات القياس المختلفة" : "These units of measure can't be converted to each other";
  }
}

/**
 * Raised when inventory configuration is incomplete in a way that makes a
 * deduction impossible — a link pointing at a missing recipe or item. This is a
 * misconfiguration, not a stock shortage, so it must not be mistaken for
 * `OutOfStockError`.
 */
export class InventoryConfigError extends DomainError {
  readonly code = "inventory_config";
  constructor(readonly detail: string) { super(`Inventory misconfigured: ${detail}`); this.name = "InventoryConfigError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "إعداد المخزون غير مكتمل" : "Inventory isn't fully configured for this item";
  }
}
