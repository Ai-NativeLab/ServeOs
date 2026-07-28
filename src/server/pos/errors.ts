/** Thrown when a pairing code cannot be redeemed (missing, expired, or already used). */
export class PosPairingError extends Error {
  constructor(message = "Invalid or expired pairing code") {
    super(message);
    this.name = "PosPairingError";
  }
}

/** Thrown when a POS device token is missing, unknown, or revoked. */
export class PosAuthError extends Error {
  constructor(message = "Invalid or revoked device token") {
    super(message);
    this.name = "PosAuthError";
  }
}

/** Thrown when POS login fails (wrong restaurant, email, password, or inactive user). */
export class PosLoginError extends Error {
  constructor(message = "Wrong restaurant, email, or password") {
    super(message);
    this.name = "PosLoginError";
  }
}

/** Thrown when a cashier's credentials are wrong, or their session is missing/expired. */
export class PosCashierError extends Error {
  constructor(message = "Invalid cashier credentials") {
    super(message);
    this.name = "PosCashierError";
  }
}

/** Thrown when the cashier lacks the permission the action requires. */
export class PosForbiddenError extends Error {
  constructor(public readonly permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = "PosForbiddenError";
  }
}

/** Thrown when a sale's tenders are internally inconsistent (bad amount, change on a card, overpayment). */
export class PosSaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosSaleError";
  }
}

/** Thrown when opening a shift on a device that already has one open. */
export class ShiftAlreadyOpenError extends Error {
  constructor(message = "This drawer already has an open shift") {
    super(message);
    this.name = "ShiftAlreadyOpenError";
  }
}

/** Thrown when cash would move with no open shift to account for it. */
export class NoOpenShiftError extends Error {
  constructor(message = "Open a shift before taking cash") {
    super(message);
    this.name = "NoOpenShiftError";
  }
}

/** Thrown when acting on a shift that is already closed. */
export class ShiftClosedError extends Error {
  constructor(message = "This shift is already closed") {
    super(message);
    this.name = "ShiftClosedError";
  }
}

/** Thrown when a count's denominations do not sum to the counted total. */
export class CashCountMismatchError extends Error {
  constructor(message = "Denominations do not sum to the counted total") {
    super(message);
    this.name = "CashCountMismatchError";
  }
}
