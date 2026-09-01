import type { EtaSubmissionStatus } from "@/server/fiscal/schema";
import type { SubmissionEmailState, SubmissionLateState } from "@/server/fiscal/read-model";

/**
 * Every coloured token the fiscal submissions table can put on a row, in a `.ts`
 * beside the `.tsx` that renders them.
 *
 * WHY IT IS NOT IN THE COMPONENT. The root suite runs `environment: "node"` and
 * its include glob matches `.test.ts` only, so no harness in this repo can mount
 * a React component — the house answer is to lift the decidable part into a `.ts`
 * beside it and assert that (`src/app/order/[token]/order-fiscal.ts`,
 * `src/app/login/safe-next.ts`). What is decidable here is exactly the thing the
 * reviews asked to be able to check: that `late` does not wear the same colour as
 * `overdue` or as a failed email. Left inline, "distinct from overdue's red" would
 * be a claim in a comment; here it is an assertion (`fiscal-chips.test.ts`).
 *
 * THE RECORDS ARE KEYED BY THE UNION'S OWN `kind`, so a state added to
 * `read-model.ts` without a token here is a COMPILE error rather than a row that
 * silently renders nothing. That is the same guarantee `SubmissionStatusCounts`
 * gets from being keyed on the status enum.
 *
 * `STATUS_CHIP` moved here from the component in the same change, so the test can
 * hold the new token against EVERY tier already on the table rather than against
 * the two the diff happened to touch.
 */

/**
 * THE HOUSE TIER SET, and it is a closed set on purpose — these six are what the
 * dashboard already speaks (`purchase-orders/page.tsx` uses the same six for its
 * own board). A seventh colour invented for one chip would mean something only to
 * whoever added it.
 */
export type ChipTier = "muted" | "slate" | "blue" | "green" | "amber" | "red";

/** The pill style: a status, a state of being. Soft fill, wide padding. */
export const TIER_CHIP_CLS: Record<ChipTier, string> = {
  muted: "bg-muted text-muted-foreground",
  slate: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
  blue: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  green: "bg-green-500/10 text-green-700 dark:text-green-400",
  amber: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  red: "bg-red-500/10 text-red-700 dark:text-red-400",
};

/**
 * The marker style: a small dense flag ATTACHED to something else — an age, an
 * email timestamp — rather than a standalone state. Denser fill so it reads as an
 * annotation on its neighbour and not as a second status.
 */
export const TIER_MARKER_CLS: Record<ChipTier, string> = {
  muted: "bg-muted text-muted-foreground",
  slate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  green: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

/** `rejected` and `failed` are the two rows an owner opens this screen to find,
 *  so they read as warnings rather than as neutral state. */
export const STATUS_CHIP: Record<EtaSubmissionStatus, ChipTier> = {
  pending: "muted",
  submitted: "blue",
  accepted: "green",
  rejected: "red",
  failed: "amber",
};

export type SubmissionMarker = { label: string; tier: ChipTier; title: string };

/**
 * PAST THE WINDOW AND STILL NOT ACCEPTED — the live condition, in red because it
 * is the one state on this table that means a sale may be undeclared right now.
 */
export const OVERDUE_MARKER: SubmissionMarker = {
  label: "overdue",
  tier: "red",
  title: "Past ETA's 24-hour submission window and not accepted. Submitting it now needs a Late Submission Request.",
};

/**
 * `null` means the state renders as plain text rather than as a marker — there is
 * nothing to flag, and a chip saying "fine" on every healthy row would drown the
 * two that are not.
 */
export const EMAIL_MARKER = {
  // Renders the send time itself; a timestamp is more useful than a word.
  sent: null,
  /**
   * AMBER, NOT RED, and Task 7's reason is worth keeping attached to the token:
   * by the time this can fail the fiscal obligation is already discharged — ETA
   * holds the document and the sale is declared — so an unsent customer copy is
   * OPERATIONAL, not fiscal, and must not read on this table as though the filing
   * itself went wrong. The reason travels in the row's own `title`, which is
   * owner-audience text on `lastError`'s exact terms.
   */
  failed: { label: "failed", tier: "amber", title: "" },
  // A real em-dash rather than a blank: nobody to email is an ANSWER.
  "no-recipient": null,
  "not-attempted": null,
} satisfies Record<SubmissionEmailState["kind"], SubmissionMarker | null>;

/**
 * SLATE, AND THE CHOICE IS NARROWER THAN IT LOOKS — every other tier on this
 * table already means something `late` is not.
 *
 *   red    "no accepted document exists, act now" (`overdue`, `rejected`). A late
 *          document may be perfectly well filed; saying this in red would put it
 *          beside the rows that are not.
 *   amber  claimed by the email failure, and claimed on a STATED principle:
 *          amber is this table's non-fiscal warning. `late` is fiscal, so amber
 *          is wrong for it on the merits and not merely because it is taken.
 *   blue   in flight (`submitted`), which a settled fact is not.
 *   green  accepted. Obviously not.
 *   muted  is what every unremarkable cell already wears; it would not be seen.
 *
 * That leaves slate, and slate is right rather than residual: the dashboard
 * already spends it on CLOSED, historical state (`purchase-orders`' "Closed"),
 * which is exactly what this is — the window was missed, the owner was told once,
 * the record never changes again, and the only outstanding action is a Late
 * Submission Request on ETA's portal that no button here can perform. The urgent
 * half of lateness is already being shouted in red two cells away by `overdue`,
 * for as long as it remains true; this is the part that outlives it.
 */
export const LATE_MARKER = {
  "on-time": null,
  late: {
    label: "late",
    tier: "slate",
    title: "Claimed past ETA's 24-hour window; the owner was notified once. ServeOS kept submitting it — "
      + "a Late Submission Request may still be required at the ETA portal.",
  },
  // No published ETA deadline for this family (VERIFY-13), so the table says
  // nothing rather than asserting a document beat a deadline nobody has shown us.
  "not-applicable": null,
} satisfies Record<SubmissionLateState["kind"], SubmissionMarker | null>;
