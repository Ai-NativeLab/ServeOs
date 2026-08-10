import type { PoStatus } from "./status";

export class InvalidPoTransitionError extends Error {
  constructor(public from: PoStatus, public to: PoStatus) {
    super(`Illegal PO transition ${from} → ${to}`);
    this.name = "InvalidPoTransitionError";
  }
}

export class SupplierEmailMissingError extends Error {
  constructor(supplierId: string) {
    super(`Supplier ${supplierId} has no email — add one before sending`);
    this.name = "SupplierEmailMissingError";
  }
}

export class PoNotFoundError extends Error {
  constructor() { super("Purchase order not found"); this.name = "PoNotFoundError"; }
}
