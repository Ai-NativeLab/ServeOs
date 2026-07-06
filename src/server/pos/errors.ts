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
