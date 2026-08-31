import { readFileSync } from "node:fs";

/**
 * The domain service modules whose mutating functions must each emit an audit
 * event (or be justified in AUDIT_ALLOWLIST). The coverage-guardrail test scans
 * exactly these. The audit module itself is not listed — it is the writer.
 *
 * WHAT LISTING A FILE DOES AND DOES NOT BUY. `enumerateMutatingSymbols` finds
 * EXPORTED functions only. A module that keeps its DB writes in private
 * top-level helpers and exposes one orchestrating entry point therefore
 * contributes ZERO symbols to the scan, and listing it is forward coverage —
 * the day someone exports a mutating function from it, the guardrail catches
 * that — rather than a statement about today. Three worker-shaped modules here
 * are in exactly that position: `notifications/worker.ts`,
 * `whatsapp/status-worker.ts` and `fiscal/worker.ts`, each of which drains a
 * queue through private per-row helpers.
 *
 * Widening the scan to private top-level functions was measured (2026-08-31):
 * 14 additional flagged writers repo-wide, 8 of them outside fiscal
 * (inventory ×6, inventory/recipes, tenancy/settings). That is a real
 * improvement and a real piece of work — other domains' justifications to
 * write — so it is deferred, not forgotten: see the post-review follow-up in
 * docs/ailab/plans/2026-07-24-eta-einvoicing-and-ereceipts.md (Task 5).
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
  // helper, and each of those calls recordFiscalAudit beside its write. Listed
  // for the forward coverage described at the head of this list.
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

export function extractFunctionBody(src: string, name: string): string {
  const clean = stripComments(src);
  const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name.replace(RESERVE, "\\$&")}\\b`);
  const m = re.exec(clean);
  if (!m) return "";
  const rest = clean.slice(m.index + m[0].length);
  const next = rest.search(BODY_BOUNDARY);
  return next >= 0 ? rest.slice(0, next) : rest;
}

// A real Drizzle write is `tx.insert(` / `db.update(` / `tx.delete(` (etc.), or a
// raw execute carrying INSERT/UPDATE/DELETE. Requiring the tx/db receiver avoids
// false positives on in-memory Map/Set `.delete(`.
const WRITE_RE = /\b(?:tx|db)\s*\.\s*(?:insert|update|delete)\s*\(|\.\s*execute\s*\(\s*sql`[^`]*\b(?:insert|update|delete)\b/i;

/** Every exported function in the audited files whose body performs a DB write. */
export function enumerateMutatingSymbols(): MutatingSymbol[] {
  const out: MutatingSymbol[] = [];
  for (const file of AUDITED_SERVICE_FILES) {
    const src = readFileSync(file, "utf8");
    const clean = stripComments(src);
    const nameRe = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\b/g;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(clean))) {
      const name = m[1];
      if (WRITE_RE.test(extractFunctionBody(src, name))) out.push({ file, name });
    }
  }
  return out;
}

/**
 * `<basename>.<symbol>` → justification. Every non-`forward:` key MUST name a
 * currently-flagged mutating symbol (the guardrail's "no stale entries" test),
 * so this list is the *complete* set of DB writers that legitimately do not emit
 * a domain audit event. `forward:` keys document emissions that land with later
 * specs; the guardrail will fail those PRs if the mutation ships without one.
 */
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
  // Forward references — land with later specs; the guardrail enforces they emit then.
  "forward:refund.*": "Spec 3 refunds must emit refund.* via recordAuditEvent",
  // NOTE: `forward:eta.*` was retired here — Spec 11's worker emits
  // eta.submission.submitted/accepted/rejected for real (fiscal/worker.ts), so
  // the promissory note has been paid. It was also never enforced: the
  // stale-entry test `continue`s on every `forward:` key, so a forward entry is
  // documentation, and documentation of a thing that now exists is just stale.
};
