import { NextResponse } from "next/server";

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

/**
 * Maps a POS auth-layer throw onto its HTTP response, or returns null when the
 * caller should keep processing other error types.
 *
 * ORDER MATTERS (#187 review, C3): PosTenantBlockedError subclasses PosAuthError.
 * Answering a blocked tenant with the blanket 401 "Unauthorized" makes the till
 * treat suspension as token death and DELETE its pairing — unrecoverable without
 * re-pairing even after reactivation. The 403 carries `code: "tenant_blocked"`
 * so clients can distinguish "retry after reactivation" from "re-pair".
 */
export function posAuthResponse(e: unknown): NextResponse | null {
  if (e instanceof PosTenantBlockedError) {
    return NextResponse.json(
      { error: e.message, code: "tenant_blocked" },
      { status: 403 },
    );
  }
  if (e instanceof PosAuthError) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * The device token itself is fine — the TENANT behind it is not servable
 * (suspended, rejected, or still onboarding). Subclasses PosAuthError so every
 * POS v1 route's existing `catch (e instanceof PosAuthError)` refuses without
 * needing to know about this case (#164); routes that surface a message to a
 * human (cashier login) can special-case it for a 403 that says why.
 */
export class PosTenantBlockedError extends PosAuthError {
  constructor(public readonly tenantStatus: string) {
    super(`This store is ${tenantStatus} — ask the platform team to reactivate it before using the till`);
    this.name = "PosTenantBlockedError";
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

/** Thrown when a refund is invalid: over-refund, line over-refund, unpaid/voided order, or amount mismatch. */
export class PosRefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosRefundError";
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

/** Thrown when a drawer movement's amount contradicts its type. */
export class CashMovementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CashMovementError";
  }
}

/** Thrown when a count's denominations do not sum to the counted total. */
export class CashCountMismatchError extends Error {
  constructor(message = "Denominations do not sum to the counted total") {
    super(message);
    this.name = "CashCountMismatchError";
  }
}
