export const OFFLINE_METHOD_TYPES = ["instapay", "vodafone_cash", "mobile_wallet", "bank", "cash"] as const;
export type OfflineMethodType = (typeof OFFLINE_METHOD_TYPES)[number];

export type VerificationState = "awaiting_payment" | "pending_verification" | "confirmed" | "rejected";

/** Payer-submitted evidence — informational only, never authoritative. */
export type PaymentProof = { reference: string | null; screenshotUrl: string | null };
