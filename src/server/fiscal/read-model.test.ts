import { describe, it, expect } from "vitest";
import { submissionSideEffects, type SubmissionEmailState, type SubmissionLateState } from "./read-model";
import type { EtaDocType, EtaSubmissionStatus } from "./schema";

/**
 * THE NULL SEMANTICS OF THE SIDE-EFFECT COLUMNS, AS TESTS RATHER THAN AS PROSE.
 *
 * `eta_submissions` records what happened alongside a filing in nullable columns
 * — `customer_emailed_at`, `customer_email_error`, `late_notified_at` — and the
 * MEANING of a null in each is not obvious from the column: two of them are null
 * both when nothing happened and when nothing was going to. Until round 2 Task 8
 * that meaning lived in a JSX ternary in `FiscalSubmissionsTable.tsx` and in a
 * comment beside it, which is to say it was asserted nowhere: the root suite runs
 * `environment: "node"` and its include glob matches `.test.ts` only, so nothing
 * in this repo can execute a `.tsx`. Moving the mapping into `read-model.ts` is
 * what makes this file possible, and this file is the reason for moving it.
 *
 * NO DATABASE. `submissionSideEffects` is a pure function of five fields, so the
 * whole state space is reachable as a table — including the combinations a
 * seeded row would take real effort to produce (a `pending` row that was
 * somehow emailed, an invoice carrying a late flag) and which are exactly where
 * a mapping goes wrong. The DB-backed side of this surface — that the columns
 * arrive at the mapper at all, and that the walk covers what comes out — is
 * pinned in `config-service.test.ts`, where the fixtures already are.
 */

const row = (over: Partial<Parameters<typeof submissionSideEffects>[0]> = {}) => ({
  docType: "e_receipt" as EtaDocType,
  status: "accepted" as EtaSubmissionStatus,
  customerEmailedAt: null,
  customerEmailError: null,
  lateNotifiedAt: null,
  ...over,
});

const AT = new Date("2026-09-01T10:00:00.000Z");
const FLAGGED = new Date("2026-09-01T11:30:00.000Z");

describe("submissionSideEffects — the customer's copy", () => {
  it("reads a stamped timestamp as sent, carrying the moment", () => {
    expect(submissionSideEffects(row({ customerEmailedAt: AT })).email).toEqual({ kind: "sent", at: AT });
  });

  it("reads an error as failed, carrying the reason for the tooltip", () => {
    expect(submissionSideEffects(row({ customerEmailError: "Error: EMAIL_FROM is not set" })).email)
      .toEqual({ kind: "failed", error: "Error: EMAIL_FROM is not set" });
  });

  it("prefers SENT over an error, so a later success is not reported as a failure", () => {
    // `deliverFiscalDocumentEmail` clears the error when a send succeeds, so this
    // pair should not occur — the ordering is what makes that a property of the
    // read rather than a promise about the writer.
    expect(submissionSideEffects(row({ customerEmailedAt: AT, customerEmailError: "stale" })).email)
      .toEqual({ kind: "sent", at: AT });
  });

  /**
   * THE DISAMBIGUATION THIS VIEW EXISTS FOR. Both columns null means two
   * different things and the dashboard was telling an owner only one of them.
   */
  it("tells 'nobody to email' apart from 'not tried yet' by the document's status", () => {
    // ACCEPTED with both columns null: the hook ran (it runs from
    // `persistAccepted` and nowhere else) and the recipient ladder came back
    // empty. A guest who left the optional field blank, or any POS sale.
    expect(submissionSideEffects(row({ status: "accepted" })).email).toEqual({ kind: "no-recipient" });

    // NOT ACCEPTED with both columns null: the hook has not run. Rendering this
    // as "nobody to email" — which the JSX ladder did — told an owner a customer
    // had declined to give an address when in truth the document was still with
    // ETA. Every pending row on the table was making that claim.
    for (const status of ["pending", "submitted", "failed"] as const) {
      expect(submissionSideEffects(row({ status })).email, status).toEqual({ kind: "not-attempted" });
    }
  });

  it("leaves a rejected document at not-attempted, permanently and correctly", () => {
    // No copy was sent and none ever will be: there is no accepted document to
    // send one of. "Not attempted" is the honest reading, not a stuck state.
    expect(submissionSideEffects(row({ status: "rejected" })).email).toEqual({ kind: "not-attempted" });
  });
});

describe("submissionSideEffects — the late-window flag", () => {
  it("reads an unflagged receipt as on-time", () => {
    expect(submissionSideEffects(row({ docType: "e_receipt" })).late).toEqual({ kind: "on-time" });
  });

  it("reads a flagged receipt as late, carrying when the owner was told", () => {
    expect(submissionSideEffects(row({ lateNotifiedAt: FLAGGED })).late).toEqual({ kind: "late", notifiedAt: FLAGGED });
  });

  it("covers the whole receipt family — a return receipt is inside ETA's 24-hour rule", () => {
    // ETA's own sentence names both: "…added to the receipt/return receipt".
    expect(submissionSideEffects(row({ docType: "return_receipt", lateNotifiedAt: FLAGGED })).late)
      .toEqual({ kind: "late", notifiedAt: FLAGGED });
  });

  it("says NOT-APPLICABLE for an invoice rather than claiming it was on time", () => {
    // No ETA SDK page publishes a submission deadline for invoice v1.0 (Task 8's
    // pre-check; VERIFY-13), so "on-time" would be asserting that this document
    // beat a deadline nobody has shown us. The third state is what lets the table
    // say nothing instead.
    expect(submissionSideEffects(row({ docType: "e_invoice" })).late).toEqual({ kind: "not-applicable" });
    expect(submissionSideEffects(row({ docType: "credit_note" })).late).toEqual({ kind: "not-applicable" });
  });

  it("does not render a stray invoice flag as late — the family gate is checked FIRST", () => {
    // Nothing writes `late_notified_at` on an invoice today (`noteLateSubmission`
    // returns before the UPDATE for a non-receipt family), so this row is
    // unreachable — which is the point. If an invoice deadline is confirmed and
    // the worker starts flagging, the READ must not begin reporting `late` before
    // this file's family rule is updated to agree with it. The two would
    // otherwise disagree silently in the tenant's favour, which is the worse
    // direction: a chip claiming a breach nobody has documented.
    expect(submissionSideEffects(row({ docType: "e_invoice", lateNotifiedAt: FLAGGED })).late)
      .toEqual({ kind: "not-applicable" });
  });
});

describe("submissionSideEffects — the state space", () => {
  it("can produce every kind of both unions, from a real column combination each", () => {
    // EXHAUSTIVENESS FROM THE TYPE, not from a hand-copied list: these arrays are
    // typed as the unions' own `kind`s, so adding a state to `read-model.ts`
    // without giving it a reachable combination here is a COMPILE error. A kind
    // nothing can produce is dead code the table still has to branch on; a kind
    // the mapper can produce but the table cannot show is a blank cell.
    const emailKinds: SubmissionEmailState["kind"][] = ["sent", "failed", "no-recipient", "not-attempted"];
    const lateKinds: SubmissionLateState["kind"][] = ["on-time", "late", "not-applicable"];

    const produced = [
      row({ customerEmailedAt: AT }),
      row({ customerEmailError: "boom" }),
      row({ status: "accepted" }),
      row({ status: "pending" }),
      row({ lateNotifiedAt: FLAGGED }),
      row({ docType: "e_invoice" }),
    ].map(submissionSideEffects);

    expect(new Set(produced.map((s) => s.email.kind))).toEqual(new Set(emailKinds));
    expect(new Set(produced.map((s) => s.late.kind))).toEqual(new Set(lateKinds));
  });

  it("derives the two effects independently — neither can mask the other", () => {
    // The worst kind of grouping bug: one cell, two facts, and a row where the
    // interesting one is the second. A document that went in late AND could not
    // be emailed must report both.
    const both = submissionSideEffects(row({ customerEmailError: "Error: EMAIL_FROM is not set", lateNotifiedAt: FLAGGED }));
    expect(both).toEqual({
      email: { kind: "failed", error: "Error: EMAIL_FROM is not set" },
      late: { kind: "late", notifiedAt: FLAGGED },
    });
  });
});
