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

export class InvalidPoInputError extends Error {
  constructor(detail: string) {
    super(`Invalid purchase input: ${detail}`);
    this.name = "InvalidPoInputError";
  }
}

export class NoBranchError extends Error {
  constructor() {
    super("This tenant has no branch — create a branch before using purchasing");
    this.name = "NoBranchError";
  }
}

export class ReceiptUomMismatchError extends Error {
  constructor(poLineId: string, ordered: string, got: string) {
    super(`Receipt line for PO line ${poLineId} is in ${got}, but the order line was in ${ordered}`);
    this.name = "ReceiptUomMismatchError";
  }
}
