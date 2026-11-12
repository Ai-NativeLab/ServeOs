/**
 * The checkout's tax-receipt email, as the two rules the form applies — pure so
 * they are testable without a DOM (the form renders nothing but "your cart is
 * empty" on the server, so its fields cannot be asserted by static render).
 *
 * The field exists only for a tenant that files with ETA (country EG AND
 * activation `active`; `checkout/page.tsx` computes `fiscalEnabled`). Every
 * other tenant's checkout neither shows it, checks it, nor sends it — the
 * request body is byte-for-byte what it was before the field existed.
 */

/** The loose shape test `placeOrder` also applies (`isEmailShaped`). */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A message for the customer, or null when there is nothing to fix. */
export function checkoutEmailError(fiscalEnabled: boolean, email: string): string | null {
  if (!fiscalEnabled) return null;
  const v = email.trim();
  if (v && !EMAIL_SHAPE.test(v)) return "That email doesn't look right — fix it, or clear it to skip the receipt.";
  return null;
}

/** The fragment spread into the `/api/orders` body. */
export function checkoutEmailPayload(fiscalEnabled: boolean, email: string): { customerEmail?: string } {
  return fiscalEnabled ? { customerEmail: email } : {};
}
