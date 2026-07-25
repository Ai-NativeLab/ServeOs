/**
 * Order-valid offline method subset. `cash` is the always-available COD default and
 * isn't configured here; `bank` is in OFFLINE_METHOD_TYPES but is NOT a valid order
 * paymentMethod (the order enum is cash/instapay/vodafone_cash/mobile_wallet — see
 * paymentMethodEnum in @/server/ordering/schema). Offering either in this dropdown
 * would let an owner create a method that silently falls back to cash at checkout.
 *
 * Lives in its own module (not the "use server" actions file) because a "use server"
 * file may only export async functions.
 */
export const ORDER_METHOD_TYPES = ["instapay", "vodafone_cash", "mobile_wallet"] as const;
