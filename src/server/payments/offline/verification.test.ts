import { describe, it, expect } from "vitest";
import { canConfirm, canReject, OFFLINE_METHOD_TYPES } from "./verification";
import { PaymentAlreadyResolvedError } from "./errors";

describe("offline verification state machine", () => {
  it("allows confirm/reject only from pending_verification", () => {
    expect(canConfirm("pending_verification")).toBe(true);
    expect(canReject("pending_verification")).toBe(true);
    for (const s of ["awaiting_payment", "confirmed", "rejected"] as const) {
      expect(canConfirm(s), s).toBe(false);
      expect(canReject(s), s).toBe(false);
    }
  });

  it("lists the supported offline method types", () => {
    expect(OFFLINE_METHOD_TYPES).toEqual(["instapay", "vodafone_cash", "mobile_wallet", "bank", "cash"]);
  });

  it("exposes a typed already-resolved error carrying a bilingual message", () => {
    const e = new PaymentAlreadyResolvedError();
    expect(e.code).toBe("payment_already_resolved");
    expect(e.messageFor("ar")).toBeTruthy();
    expect(e.messageFor("en")).toBeTruthy();
  });
});
