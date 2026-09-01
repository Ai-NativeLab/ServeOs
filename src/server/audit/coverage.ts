import { readFileSync } from "node:fs";

/**
 * The domain service modules whose mutating functions must each emit an audit
 * event (or be justified in AUDIT_ALLOWLIST). The coverage-guardrail test scans
 * exactly these. The audit module itself is not listed — it is the writer.
 *
 * WHAT LISTING A FILE BUYS — and this changed in round 2 Task 10b, so the old
 * caveat is rewritten rather than left to mislead. `enumerateMutatingSymbols`
 * used to find EXPORTED functions only, which meant a module keeping its writes
 * in private top-level helpers behind one orchestrating entry point contributed
 * ZERO symbols: listing it was forward coverage, not a statement about today.
 * Three worker-shaped modules were in exactly that position
 * (`notifications/worker.ts`, `whatsapp/status-worker.ts`, `fiscal/worker.ts`),
 * and so, less obviously, was inventory's whole lot-level layer.
 *
 * THE SCAN NOW REACHES PRIVATE TOP-LEVEL DECLARATIONS — `function f` and
 * `const f = (…) =>` at column 0, exported or not. Listing a file now means its
 * module-level writers are covered, full stop.
 *
 * WHAT THAT COST, MEASURED. The symbol count went from ~40 exported to **124**,
 * and 12 previously-invisible writers surfaced needing a disposition: 4 fiscal
 * (2 given real `eta.submission.failed` emissions, 2 allowlisted) and 8 foreign
 * (inventory ×6, inventory/recipes, tenancy/settings), each investigated by
 * reading its call path. One of those eight turned out to be a GENUINE
 * UNAUDITED PATH rather than a justifiable one — see
 * `settings.applySettingsPatch` below, which is ticketed rather than papered
 * over. The 2026-08-31 estimate of "14 additional" was close: the difference is
 * two fiscal writers that have since gained emissions of their own.
 *
 * STILL OUT OF REACH, so that the next reader knows the shape of what remains:
 * class methods, and writers nested inside another function. Neither exists in
 * the listed files today.
 */
export const AUDITED_SERVICE_FILES = [
  "src/server/whatsapp/linking.ts",
  "src/server/whatsapp/runner.ts",
  "src/server/whatsapp/status-worker.ts",
  "src/server/customers/service.ts",
  "src/server/prescriptions/service.ts",
  "src/server/notifications/service.ts",
  "src/server/notifications/worker.ts",
  "src/server/ordering/service.ts",
  "src/server/pos/record-sale.ts",
  "src/server/pos/refund.ts",
  "src/server/pos/cashier.ts",
  "src/server/pos/grants.ts",
  "src/server/pos/held-tickets.ts",
  "src/server/pos/service.ts",
  "src/server/pos/shifts.ts",
  "src/server/pos/cash-movements.ts",
  "src/server/pos/sync-ingest.ts",
  "src/server/fiscal/enqueue.ts",
  "src/server/fiscal/finalize.ts",
  // Contributes no symbols today: drainEtaSubmissions is its only export and it
  // writes nothing directly — every status write lives in a private per-row
  // helper. Listed for the forward coverage described at the head of this list.
  //
  // "…and each of those helpers emits beside its write" WAS TRUE AND IS NO
  // LONGER, which is why the claim has been removed rather than left to age:
  // round 2 Task 8 added `noteLateSubmission`, a private writer that
  // deliberately emits nothing (see its `pending-scan:` entry below for the
  // reasoning). The blanket statement would have been the only thing telling a
  // reader of this list that fiscal's private writers are all clean, at exactly
  // the moment one of them stopped being.
  "src/server/fiscal/worker.ts",
  // Real present coverage, unlike the three worker-shaped modules above: both
  // of its writers are exported, both are owner actions on a compliance
  // surface, and both emit (eta.config.updated / eta.device_credentials.updated).
  "src/server/fiscal/config-service.ts",
  // Read-only today — it is the cashier-reachable half of the fiscal API and
  // writes nothing at all, so it contributes zero symbols. Listed purely as
  // forward coverage: a read module that grows a writer is exactly the change
  // that should have to justify itself.
  "src/server/fiscal/read-model.ts",
  "src/server/catalog/service.ts",
  "src/server/catalog/variants.ts",
  "src/server/inventory/service.ts",
  "src/server/inventory/recipes.ts",
  "src/server/purchasing/service.ts",
  "src/server/purchasing/suppliers.ts",
  "src/server/purchasing/receiving.ts",
  "src/server/purchasing/send.ts",
  "src/server/purchasing/reorder.ts",
  "src/server/purchasing/variance.ts",
  "src/server/branches/service.ts",
  "src/server/tenancy/settings.ts",
  "src/server/tenancy/service.ts",
  "src/server/auth/staff.ts",
  "src/server/auth/session.ts",
  "src/server/banners/service.ts",
  "src/server/subscription/service.ts",
  "src/server/onboarding/service.ts",
];

export type MutatingSymbol = { file: string; name: string };

/** File basename without the `.ts` extension — the prefix in an allowlist key. */
export function basename(file: string): string {
  return (file.split("/").pop() ?? file).replace(/\.ts$/, "");
}

/** Strip block + line comments so a commented-out write or emit is not counted.
 *  The line-comment rule ignores `://` so URLs inside strings survive. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const RESERVE = /[.*+?^${}()|[\]\\]/g;

/**
 * The body of `export (async )?function <name>` — from the signature to the
 * next TOP-LEVEL declaration (column 0), exported or not. Stopping at the next
 * declaration (not just the next `export`) keeps a following non-exported helper
 * — restockOrderItems, applySettingsPatch — from bleeding its writes into the
 * preceding read's body. Robust against braces inside the body because it does
 * not brace-match (return types like `Promise<{…}>` would defeat that). Comments
 * are stripped first so nothing inside a function body sits at column 0.
 */
const BODY_BOUNDARY = /\n(?:export|async\s+function|function|const|let|var|class|abstract|type|interface|enum)\b/;

/**
 * The two spellings a top-level writer can have, as one pattern.
 *
 * `function foo(` and `const foo = (…) =>` are the same thing to this
 * guardrail — code that writes to the database and must therefore emit or be
 * justified — so they share a matcher rather than drifting apart in two places
 * (the enumerator's and the body extractor's). `export` is OPTIONAL in both
 * arms: that is the whole of round 2 Task 10b, which widened the scan from
 * exported functions to every top-level declaration.
 *
 * THE ARROW ARM REQUIRES AN OPENING PAREN after the `=`, so `const LIMIT = 50`
 * and `const REGISTRY = {…}` are not mistaken for functions. It accepts an
 * intervening type annotation (`const f: Handler = (…) =>`) and `async`.
 */
function declarationPattern(nameFragment: string): string {
  return `(?:export\\s+)?(?:(?:async\\s+)?function\\s+${nameFragment}\\b`
    + `|const\\s+${nameFragment}\\s*(?::[^=\\n]*)?=\\s*(?:async\\s+)?(?:function\\b|\\())`;
}

export function extractFunctionBody(src: string, name: string): string {
  const clean = stripComments(src);
  const m = new RegExp(declarationPattern(name.replace(RESERVE, "\\$&"))).exec(clean);
  if (!m) return "";
  const rest = clean.slice(m.index + m[0].length);
  const next = rest.search(BODY_BOUNDARY);
  return next >= 0 ? rest.slice(0, next) : rest;
}

// A real Drizzle write is `tx.insert(` / `db.update(` / `tx.delete(` (etc.), or a
// raw execute carrying INSERT/UPDATE/DELETE. Requiring the tx/db receiver avoids
// false positives on in-memory Map/Set `.delete(`.
const WRITE_RE = /\b(?:tx|db)\s*\.\s*(?:insert|update|delete)\s*\(|\.\s*execute\s*\(\s*sql`[^`]*\b(?:insert|update|delete)\b/i;

/**
 * Every TOP-LEVEL function in the audited files whose body performs a DB write —
 * exported or not.
 *
 * IT USED TO FIND EXPORTED FUNCTIONS ONLY, and that was the guardrail's largest
 * blind spot rather than a detail of its implementation. The shape it missed is
 * the commonest one in this codebase: a module exposing one orchestrating entry
 * point whose actual writes live in private helpers below it. Three
 * worker-shaped modules were in exactly that position — `notifications/worker`,
 * `whatsapp/status-worker`, `fiscal/worker` — contributing ZERO symbols each
 * while writing on every pass. A guardrail that can be silenced by not
 * exporting something is a guardrail that rewards the wrong refactor.
 *
 * ANCHORED AT COLUMN 0 (`^` under the `m` flag), which is what keeps "private"
 * from meaning "any nested closure". Only declarations flush with the left
 * margin are module-level; a `const handler = (…) =>` inside another function is
 * that function's business and is covered by its enclosing body. The anchoring
 * is conservative in one known way: a declaration preceded on the SAME LINE by a
 * block comment starts at column 1 after `stripComments` and is skipped. That
 * direction is the safe one — an under-scan, never a false accusation — and no
 * file in the list is written that way today.
 */
export function enumerateMutatingSymbols(): MutatingSymbol[] {
  const out: MutatingSymbol[] = [];
  for (const file of AUDITED_SERVICE_FILES) {
    const src = readFileSync(file, "utf8");
    const clean = stripComments(src);
    // Two capture groups, one per arm of the pattern — whichever arm matched is
    // the one that is defined.
    const nameRe = new RegExp(`^${declarationPattern("([A-Za-z0-9_]+)")}`, "gm");
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(clean))) {
      const name = m[1] ?? m[2];
      if (WRITE_RE.test(extractFunctionBody(src, name))) out.push({ file, name });
    }
  }
  return out;
}

/**
 * `<basename>.<symbol>` → justification. Every plain key MUST name a
 * currently-flagged mutating symbol (the guardrail's "no stale entries" test),
 * so this list is the *complete* set of DB writers that legitimately do not emit
 * a domain audit event. `forward:` keys document emissions that land with later
 * specs; the guardrail will fail those PRs if the mutation ships without one.
 *
 * `pending-scan:<basename>.<symbol>` IS A THIRD KIND, and it exists because the
 * scanner's REACH is about to change. `enumerateMutatingSymbols` matches
 * `export function` only, so a PRIVATE writer is invisible to it — that is the
 * gap round 2 Task 10b widens the scan to close, and the widening will surface a
 * batch of writers at once. A `pending-scan:` key is a disposition DECIDED IN
 * ADVANCE for one of them, written by the task that added the writer, while it
 * still remembers why. The coverage test HONOURS the prefix — so the day the
 * scan widens, the entry is already in force and the symbol is not reported as a
 * fresh gap needing adjudication by someone who did not write it.
 *
 * THE PREFIX EXPIRES ITSELF. The stale-entry test does not skip these keys; it
 * INVERTS its usual assertion and requires the bare symbol to still be
 * un-enumerable. So widening the scan does not quietly leave a stale prefix
 * behind — it turns every one of them into a failing assertion naming the key
 * and the fix ("drop the prefix"). A temporary marker whose cleanup depends on a
 * later task remembering it exists is a permanent marker; this one is removed by
 * the guardrail asking for it.
 *
 * IT IS NOT A PARKING SPACE. `pending-scan:` says "the answer is settled and
 * here it is"; it never means "not looked at yet". When Task 10b widens the
 * scan, every one of these becomes an ordinary key by deleting the prefix — and
 * an entry whose justification cannot survive that edit was never a disposition
 * in the first place.
 */
export const PENDING_SCAN_PREFIX = "pending-scan:";
export const AUDIT_ALLOWLIST: Record<string, string> = {
  // Conversation rows are the bot's internal cursor, not a domain mutation.
  // The domain event — the order — is audited inside the same turn:
  // runPlaceOrder emits whatsapp.order_placed on the caller's tx.
  "runner.handleInbound": "whatsapp.order_placed emitted by runPlaceOrder on the placing turn",
  // Read-state on the caller's own feed — the notification's existence is the
  // record; when someone dismissed their badge is not a domain event.
  "service.markNotificationsRead": "user's own read cursor, not a domain mutation",
  // Session primitives are not domain actions; auth.login / auth.logout are
  // emitted at the action boundary (loginAction / registerAction / signOutAction).
  "session.createSession": "auth.login emitted by login/register actions",
  "session.invalidateSession": "auth.logout emitted by signOutAction",
  // Customer session primitives mirror the staff ones: customer.login /
  // customer.login_failed are emitted by authenticateCustomer, logout at the
  // action boundary.
  "service.createCustomerSession": "customer.login emitted by authenticateCustomer",
  "service.invalidateCustomerSession": "customer.logout emitted by the sign-out action",
  // Low-level tenant bootstrap: registration goes through registerTenant, which
  // emits tenant.registered. createTenant is a bare control-table insert used by
  // seeds/tooling with no tenant context to attribute an actor to.
  "service.createTenant": "bootstrap insert; tenant.registered emitted by registerTenant",
  // The rejection's own write only claims the paymentStatus; the domain event is
  // the cancellation it then delegates to, which emits order.status_changed with
  // the same actor and reason. Confirming, which has no such delegate, emits
  // payment.confirmed directly.
  "service.rejectOrderPayment": "order.status_changed emitted by the transitionStatus it delegates to",
  // Refund restock is a sub-effect of issueRefund, which emits refund.issued on
  // the same tx — the stock add-back is the refund's ledger, not a domain event.
  "service.restockRefundedLines": "refund.issued emitted by issueRefund on the same tx",
  // Inventory (Spec 8). The operator-driven movements — adjustStock,
  // transferStock, commitCount — emit inventory.* directly. These three write to
  // the ledger without their own event because the action that causes them is
  // already audited at a higher level, and a stock_ledger row is itself an
  // immutable record (the table is append-only, enforced by trigger).
  "service.receiveStock": "caller owns the event: po.received (Spec 9) or the backfill's opening balance",
  "service.reverseOrderDeductions": "order.status_changed emitted by the cancel/refund that triggers it",
  // Provisions a branch's default storage location on first use so a sale is
  // never blocked on missing setup. Configuration of a location, not a stock
  // movement — nothing about on-hand changes.
  "service.getOrCreateDefaultLocation": "lazily provisions a branch default location; no stock movement",
  // Entering counted lines is data capture on an open count, not a domain
  // mutation — nothing about stock changes until commitCount, which emits
  // inventory.count.commit and carries the variance-line count with it.
  "service.addCountLines": "inventory.count.commit emitted by commitCount; lines alone move no stock",
  "service.openCount": "inventory.count.commit emitted by commitCount; an open count moves no stock until committed",
  // POS control-plane token tables (cashier sessions, manager grants). These rows
  // are credentials, not domain state: signInCashier emits auth.cashier_signed_in
  // / auth.login_failed, the authorize route emits authz.manager_granted beside
  // issueGrant, and a consumed grant is recorded by the gated action's own event
  // through authorizedByUserId. The expiry deletes are garbage collection of rows
  // that were already inert — a swept token authorizes nothing either way.
  "cashier.resolveCashier": "expiry sweep of an already-inert row; auth.cashier_signed_in emitted by signInCashier",
  "grants.issueGrant": "authz.manager_granted emitted by the authorize route beside this call",
  "grants.consumeGrant": "the gated action's own audit event carries authorizedByUserId",
  // Fiscal (Spec 11). enqueueFiscalDocument's insert is bookkeeping attached
  // to a sale/refund that is already audited at its own call site
  // (sale.recorded / refund.issued) — it names no new domain fact. The
  // submission's own lifecycle (submitted/accepted/rejected) is emitted by the
  // worker, on the row this insert creates.
  "enqueue.enqueueFiscalDocument": "the eta_submissions row is bookkeeping for a sale/refund already audited as sale.recorded / refund.issued; eta.* events land with Task 5's worker",
  // enqueueCorrectedResubmission takes no actor — its `ctx` is `{ tenantId }`
  // — so an event emitted here would be attributed to the system, which is a
  // lie: correcting a rejected document is a deliberate human decision. The
  // row it inserts is not invisible either; the worker audits its
  // submitted/accepted/rejected lifecycle exactly like the original's. The
  // missing fact is WHO asked for it, and that belongs to the dashboard route
  // that knows the user (Task 6).
  "enqueue.enqueueCorrectedResubmission": "no actor in scope; the correction's own lifecycle is audited by the worker, and the who-asked-for-it event belongs to Task 6's dashboard route",
  // finalizeSubmissionRow assigns a queued document its fiscal identity — wire
  // JSON, self-computed uuid, QR, and the device's chain head. That is the
  // document being PREPARED, not a domain fact reaching anyone: nothing has
  // been declared to ETA and nothing is user-visible until the worker submits
  // it, and the worker audits that lifecycle (submitted/accepted/rejected) on
  // the same row. It also runs from the sale path, where an event would be
  // attributed to a system actor beside the sale.recorded that already names
  // the cashier. `eta.submission.*` is the whole fiscal vocabulary
  // (fiscal/effects.ts) and none of it describes "hashed, not yet sent".
  "finalize.finalizeSubmissionRow": "prepares a queued document (uuid/QR/chain head); the submission lifecycle it feeds is audited as eta.submission.* by the worker on the same row",
  // noteLateSubmission (round 2 Task 8) writes `late_notified_at` and sends the
  // owner one alert when a claimed receipt is past ETA's 24-hour window. It is
  // PRIVATE, so today's exported-only scan cannot see it — hence `pending-scan:`;
  // Task 10b's widening will, and this is its decided disposition rather than a
  // fifteenth gap for whoever runs that task to adjudicate cold.
  //
  // NO AUDIT ACTION IS MINTED, deliberately. The `eta.submission.*` vocabulary
  // (fiscal/effects.ts) names things that HAPPENED TO THE DOCUMENT at ETA —
  // submitted, accepted, rejected — and nothing happened to this one: the clock
  // passed a threshold while the row sat where it was. It is a SYSTEM
  // OBSERVATION about our own pipeline's timing, with no actor (a scheduled
  // drain), no state change to the fiscal record, and no effect on what is filed
  // — the worker submits the document either way, which is the whole design.
  // Minting `eta.submission.late` would put a non-event in the audit trail that
  // reads like one, and an auditor would reasonably ask which ETA interaction it
  // records. None.
  //
  // AND IT IS ALREADY RECORDED TWICE, durably: `late_notified_at` is the
  // timestamped fact on the row itself (queryable, and what the dashboard's
  // `late` state is derived from), and the owner notification is the delivery of
  // it. A third copy in `audit_events` would add no fact and no reader.
  // THE PREFIX IS GONE BECAUSE THE SCAN REACHED IT (round 2 Task 10b). This
  // entry was written as `pending-scan:worker.noteLateSubmission` by the task
  // that added the writer; widening the scan made the bare symbol enumerable,
  // the stale-entry test failed by name with "drop the prefix", and this is that
  // edit. The disposition below is unchanged from the day it was decided, which
  // is the entire point of having decided it then.
  "worker.noteLateSubmission": "system observation of our own timing, not an ETA interaction; the owner notification + `late_notified_at` ARE the record, and an eta.submission.* action is deliberately not minted for a non-event",
  // pollPhase's own write is the NON-terminal branch: ETA answered "still
  // processing", so the row's status is corrected back to `submitted` and the
  // poll clock moves. Nothing happened to the document — that is precisely what
  // ETA said — and the two branches that DO carry a verdict are delegated to
  // `persistAccepted` / `persistRejected`, which emit eta.submission.accepted /
  // rejected themselves and are therefore not flagged here.
  "worker.pollPhase": "writes only the 'ETA is still processing' correction; the accepted/rejected verdicts it routes to emit eta.submission.* from persistAccepted/persistRejected",
  // The invoice twin of finalizeSubmissionRow, allowlisted on identical terms:
  // it builds and persists the document's bytes (wire JSON, and for a signed
  // tenant the CAdES-BES signature), which is the document being PREPARED. An
  // invoice has no self-computed uuid to assign — ETA names it in the 202 — so
  // even less is decided here than on the receipt path. Nothing has been
  // declared to ETA and nothing is user-visible until the worker submits it, and
  // the worker audits that lifecycle on the same row.
  "finalize.finalizeInvoiceRow": "prepares a queued invoice's bytes (wire JSON + signature); the submission lifecycle it feeds is audited as eta.submission.* by the worker on the same row",
  // ==========================================================================
  // FOREIGN DOMAINS, surfaced by round 2 Task 10b's widened scan.
  //
  // These are inventory's and tenancy's writers, not fiscal's. The fiscal task
  // that widened the scan is permitted to add COMMENTS AND ALLOWLIST ENTRIES
  // here and nothing else — no emissions, no signature changes, no behaviour —
  // because a domain's audit vocabulary is that domain's decision. Each entry
  // below was written only after reading the path it names; where a path turned
  // out NOT to be audited, the entry says so instead of borrowing a nearby
  // event's credibility.
  //
  // The inventory six are all LOT-LEVEL PRIMITIVES. They were invisible to the
  // old scan for a structural reason worth naming: `deductForOrderLine` and
  // `syncLinkedSellable` are exported, but every statement that touches a row
  // lives in these private helpers, so neither the export nor the helper was
  // ever flagged — the export because it contains no write, the helper because
  // it was not exported. That is the exact blind spot the widening closes.
  // ==========================================================================
  // creditLot / debitLots are reached from FOUR exported paths and every one of
  // them is accounted for: adjustStock (emits inventory.adjusted), transferStock
  // (emits inventory.transferred), commitCount (emits inventory.count.commit) —
  // all three verified by reading the recordAuditEvent call in each body — plus
  // receiveStock, whose own allowlist entry above already says the caller owns
  // the event (po.received). The remaining callers are the other private helpers
  // in this block, which resolve to order.placed; see below.
  "service.creditLot": "lot-level primitive; every caller is audited — adjustStock/transferStock/commitCount emit their own events, receiveStock is allowlisted to its caller, and the deduction helpers resolve to order.placed",
  "service.debitLots": "lot-level primitive; same four audited callers as creditLot (adjustStock/transferStock/commitCount emit; deductFifo resolves to order.placed)",
  // The deduction family has ONE entry point: `deductForOrderLine`, called from
  // `placeOrder` (ordering/service.ts) inside placeOrder's own transaction, with
  // `recordAuditEvent({action: "order.placed"})` on that same tx immediately
  // after the deduction loop. Read and confirmed line by line — the deduction is
  // atomic with the event that records it, so a deduction cannot exist without
  // its audit row.
  "service.deductFifo": "reached only from deductForOrderLine ← placeOrder, which emits order.placed on the same tx immediately after the deduction loop",
  "service.deductCutToSize": "reached only from deductForOrderLine ← placeOrder, which emits order.placed on the same tx immediately after the deduction loop",
  "service.adoptLegacyTrackedStock": "reached only from deductForOrderLine ← placeOrder (order.placed on the same tx); migrates a legacy integer balance into a lot as a side effect of the sale that needed it",
  // mirrorLegacyStock has a second caller, and the honest note is that it has no
  // production reach: `syncLinkedSellable` is exported but called from nowhere in
  // `src` today (only a comment in purchasing/locking.ts references it). So the
  // live path is the deduction one; if syncLinkedSellable ever acquires a caller,
  // that caller owes an event and this entry stops being complete.
  "service.mirrorLegacyStock": "live path is deductForOrderLine ← placeOrder (order.placed, same tx); its other caller syncLinkedSellable is exported but has no caller in src today — a future caller owes its own event",
  // Both callers verified: createRecipe and setRecipeComponents each call
  // writeComponents and then recordAuditEvent on the same tx, a few lines apart.
  "recipes.writeComponents": "both callers — createRecipe and setRecipeComponents — emit their own recipe.* event on the same tx immediately after this returns",
  /**
   * PARTIALLY AUDITED, AND THIS ENTRY SAYS SO RATHER THAN ROUNDING UP.
   *
   * Three of `applySettingsPatch`'s four callers emit on the same transaction
   * (the WhatsApp number change, the plan-upgrade request, and the settings
   * update at :170). The fourth is `patchTenantSettings`, a private wrapper that
   * emits NOTHING — and five exported setters route through it:
   * `setVatRate`, `setVatEnabled`, `setPricesIncludeVat`, `setServiceChargeRate`
   * and `setAllowNegativeStock`.
   *
   * FOUR OF THOSE FIVE ARE FISCALLY LOAD-BEARING. They decide how VAT is
   * computed on every subsequent sale and therefore what is declared to ETA, so
   * "who changed the VAT rate, and when" is exactly the question an audit log
   * exists to answer — and today it cannot. This is a REAL GAP in the tenancy
   * domain, found by this scan rather than reasoned away by it.
   *
   * IT IS NOT FIXED HERE, deliberately: emitting from tenancy is a behaviour
   * change in a foreign domain, and this task's remit there is comments and
   * allowlist entries only. Ticketed in the round-2 plan's future list. The
   * entry is worded so nobody reads it as a clean bill of health.
   */
  "settings.applySettingsPatch": "PARTIAL: the three direct callers emit on the same tx, but the patchTenantSettings path (setVatRate/setVatEnabled/setPricesIncludeVat/setServiceChargeRate/setAllowNegativeStock) emits NOTHING — a real tenancy-domain gap, ticketed, not fixed under a fiscal task's foreign-touch rule",
  // Forward references — land with later specs; the guardrail enforces they emit then.
  "forward:refund.*": "Spec 3 refunds must emit refund.* via recordAuditEvent",
  // NOTE: `forward:eta.*` was retired here — Spec 11's worker emits
  // eta.submission.submitted/accepted/rejected for real (fiscal/worker.ts), so
  // the promissory note has been paid. It was also never enforced: the
  // stale-entry test `continue`s on every `forward:` key, so a forward entry is
  // documentation, and documentation of a thing that now exists is just stale.
};
