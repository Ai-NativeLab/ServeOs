import { DomainError, type Locale } from "@/shared/errors";

export class StaffContactTakenError extends DomainError {
  readonly code = "staff_contact_taken";
  constructor(public readonly contact: string) {
    super(`Email or phone already in use: ${contact}`);
    this.name = "StaffContactTakenError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "البريد الإلكتروني أو رقم الهاتف مستخدم بالفعل"
      : "That email or phone is already in use by another account";
  }
}

/** No valid session cookie — the visitor is signed out. */
export class NotSignedInError extends Error {
  readonly code = "not_signed_in";
  constructor() {
    super("Not signed in");
    this.name = "NotSignedInError";
  }
}

/** Signed in, but missing the platform role the route requires. */
export class ForbiddenError extends Error {
  readonly code = "forbidden";
  constructor(message = "Forbidden: super admin only") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * True only for the two *expected* ways admin auth fails. Everything else — a
 * DB outage, schema drift, a plain bug — must keep propagating to an error
 * boundary rather than being reinterpreted as "signed out", which would send a
 * real incident round the login redirect and hide it.
 */
export function isAdminAuthError(e: unknown): boolean {
  return e instanceof NotSignedInError || e instanceof ForbiddenError;
}
