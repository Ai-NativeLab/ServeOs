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
