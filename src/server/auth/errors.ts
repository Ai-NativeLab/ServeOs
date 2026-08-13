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

/** A password that fails the policy in @/lib/validation/fields. */
export class WeakPasswordError extends DomainError {
  readonly code = "weak_password";
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "WeakPasswordError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "كلمة المرور ضعيفة جدًا" : this.reason;
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

/** Where an admin surface should send someone after `e`, or null to rethrow. */
export const ADMIN_LOGIN_PATH = "/admin/login";
export const ADMIN_NO_ACCESS_PATH = "/admin/no-access";

/**
 * Maps the two *expected* admin auth failures to where the visitor should go.
 * Returns null for everything else — a DB outage, schema drift, a plain bug —
 * so it keeps propagating to an error boundary instead of being reinterpreted
 * as "signed out", which would send a real incident round the login redirect
 * and hide it.
 *
 * The two cases deliberately differ. Someone signed out needs the login form.
 * Someone signed in without the role does not: re-prompting for credentials
 * that are already correct renders a clean form and reads as a password
 * problem, which is precisely how the missing-role failure disguised itself.
 */
export function adminAuthRedirectPath(e: unknown): string | null {
  if (e instanceof NotSignedInError) return ADMIN_LOGIN_PATH;
  if (e instanceof ForbiddenError) return ADMIN_NO_ACCESS_PATH;
  return null;
}
