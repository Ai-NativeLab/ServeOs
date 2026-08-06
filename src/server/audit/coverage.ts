import { readFileSync } from "node:fs";

/**
 * The domain service modules whose mutating functions must each emit an audit
 * event (or be justified in AUDIT_ALLOWLIST). The coverage-guardrail test scans
 * exactly these. The audit module itself is not listed — it is the writer.
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
  "src/server/pos/held-tickets.ts",
  "src/server/pos/service.ts",
  "src/server/pos/shifts.ts",
  "src/server/pos/cash-movements.ts",
  "src/server/catalog/service.ts",
  "src/server/catalog/variants.ts",
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
  // Forward references — land with later specs; the guardrail enforces they emit then.
  "forward:inventory.*": "Spec 8 ledger/lot/count must emit inventory.*",
  "forward:purchase-order.*": "Spec 9 PO lifecycle must emit po.*",
  "forward:eta.*": "Spec 11 fiscal submissions must emit eta.*",
};
