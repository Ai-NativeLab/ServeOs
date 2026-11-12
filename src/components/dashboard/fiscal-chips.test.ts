import { describe, it, expect } from "vitest";
import {
  EMAIL_MARKER, LATE_MARKER, OVERDUE_MARKER, STATUS_CHIP,
  TIER_CHIP_CLS, TIER_MARKER_CLS, type ChipTier,
} from "./fiscal-chips";

/**
 * The fiscal table's colour vocabulary, asserted rather than described.
 *
 * WHAT THIS FILE IS FOR. "The late chip must be distinct from overdue's red" is
 * a review requirement, and left in the component it would be a claim in a
 * comment — no harness here can mount a `.tsx` (root suite: `environment:
 * "node"`, include glob `.test.ts`). With the tokens in a plain `.ts` beside it,
 * the requirement is a comparison. It is a small test guarding a specific kind of
 * regression: someone tidying the palette collapsing two tiers that mean
 * different things, on the one screen where colour carries compliance meaning.
 */

describe("fiscal chip tokens", () => {
  it("gives the late marker a tier of its own — not overdue's, not the email failure's", () => {
    // THE REVIEW REQUIREMENT, as an assertion. `overdue` is red because it means
    // a sale may be undeclared right now; `email failed` is amber because the
    // filing succeeded and only the courtesy copy did not; `late` is neither —
    // it is a settled historical fact whose remaining action is at ETA's portal.
    // Three meanings, three tiers.
    expect(LATE_MARKER.late.tier).not.toBe(OVERDUE_MARKER.tier);
    expect(LATE_MARKER.late.tier).not.toBe(EMAIL_MARKER.failed.tier);
    expect(new Set([LATE_MARKER.late.tier, OVERDUE_MARKER.tier, EMAIL_MARKER.failed.tier]).size).toBe(3);
  });

  it("does not reuse a tier that already means something else on this table", () => {
    // Held against EVERY status tier, not just the two the change touched: a
    // `late` chip wearing `submitted`'s blue or `accepted`'s green would read as
    // a status the row does not have, which is worse than an unfamiliar colour.
    expect(Object.values(STATUS_CHIP)).not.toContain(LATE_MARKER.late.tier);
  });

  it("resolves every tier to a class in both styles, so no marker can render unstyled", () => {
    const tiers: ChipTier[] = ["muted", "slate", "blue", "green", "amber", "red"];
    for (const tier of tiers) {
      expect(TIER_CHIP_CLS[tier], tier).toBeTruthy();
      expect(TIER_MARKER_CLS[tier], tier).toBeTruthy();
    }
    // The two styles are genuinely different renderings of one tier — the pill
    // for a state, the dense flag for an annotation on a neighbouring value.
    // Identical classes would mean the distinction had quietly been dropped.
    expect(TIER_MARKER_CLS.red).not.toBe(TIER_CHIP_CLS.red);
  });

  it("gives every fiscal status a chip tier", () => {
    // Keyed on the status enum, so this is really a compile-time guarantee; the
    // runtime check is here because a status losing its entry to a bad merge is
    // an invisible failure (an unstyled chip still renders its text).
    for (const [status, tier] of Object.entries(STATUS_CHIP)) {
      expect(TIER_CHIP_CLS[tier], status).toBeTruthy();
    }
  });

  it("flags only the states worth flagging, and leaves the healthy ones as plain text", () => {
    // A marker on every row is a marker on no row. `sent` shows its timestamp,
    // and the two "nothing was sent" states are told apart by their text and
    // tooltip in the cell rather than by a colour that would rank them as
    // problems — neither is one.
    expect(EMAIL_MARKER.sent).toBeNull();
    expect(EMAIL_MARKER["no-recipient"]).toBeNull();
    expect(EMAIL_MARKER["not-attempted"]).toBeNull();
    expect(LATE_MARKER["on-time"]).toBeNull();
    // NOT-APPLICABLE RENDERS NOTHING, deliberately: no ETA page publishes an
    // invoice submission deadline (VERIFY-13), so a "n/a" chip would be the
    // table volunteering a fact about a rule nobody has confirmed exists.
    expect(LATE_MARKER["not-applicable"]).toBeNull();
  });

  it("carries the late marker's tooltip meaning: still submitting, portal action may be needed", () => {
    // The label is one word on a crowded row; the tooltip is where an owner finds
    // out that ServeOS did NOT give up and that the remaining step is theirs.
    expect(LATE_MARKER.late.title).toContain("Late Submission Request");
    expect(LATE_MARKER.late.title).toContain("kept submitting");
  });
});
