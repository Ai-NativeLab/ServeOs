import type { VerificationState } from "./types";
export { OFFLINE_METHOD_TYPES } from "./types";
export type { OfflineMethodType, VerificationState, PaymentProof } from "./types";

export function canConfirm(state: VerificationState): boolean {
  return state === "pending_verification";
}
export function canReject(state: VerificationState): boolean {
  return state === "pending_verification";
}
