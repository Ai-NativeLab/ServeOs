# ETA e-Invoicing & e-Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use mo-ai:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **2026-08-30: the VERIFY gate is largely lifted** — items 1–6 and 8 are resolved against official ETA sources; wire format, QR, UUID-chain and auth are now specifiable. **`docs/ailab/specs/2026-08-30-eta-verified-findings-addendum.md` is the authoritative delta and WINS over any conflicting text in this plan** (notably: per-device UUID chain + per-device credentials tables in Task 1, `return_receipt` docType, QR at issuance in Task 7, poll phase in Task 5).

**Goal:** Fiscalise every EG tenant's POS/online sale and refund with the **Egyptian Tax Authority (ETA)** behind a `FiscalProvider` interface (shaped like `BillingProvider`). A committed sale **enqueues** an `e_receipt` submission; a scheduled worker submits it asynchronously with retry/backoff and, once ETA **accepts**, persists the **UUID + QR**; the receipt renders them. A Spec 3 refund enqueues a **`credit_note`** referencing the original receipt's UUID. Each line carries an **EGS/GS1** code + tax type from `product_tax_codes`. Submissions emit Spec 4 audit events and raise a Spec 5 `critical` notification on terminal failure. The entire subsystem is gated on `tenants.country === "EG"`; non-EG tenants resolve a `NoopFiscalProvider` and see **no behavioural change**. Implements `docs/ailab/specs/2026-07-24-eta-einvoicing-and-ereceipts-design.md` (Spec 11, decision **D8**).

**Architecture:** The **sale is never blocked by ETA.** `recordSale` commits the sale (tenders, adjustments, `pos_order_receipts`) exactly as today; **after** that commit it does one cheap, local DB insert — a `pending` `eta_submissions` row via `enqueueFiscalDocument` — and returns. No network call is on the request path. A scheduled worker (`drainEtaSubmissions`, mirroring Spec 5's outbox worker) claims `pending|failed` rows with `SELECT … FOR UPDATE SKIP LOCKED`, resolves the tenant's `EtaConfig` (secrets decrypted server-side from refs, never from a row), builds the document from `product_tax_codes` via the **pure** `buildReceipt`/`buildCreditNote` mappers, signs it, `submit`s to ETA, and records `etaUuid`/`qrPayload`/`status` with `attempts`++ and backoff. `eta_submissions` **is** the offline queue: a sale during an ETA outage commits `pending` and drains when connectivity returns. Provider selection is per-tenant by country: `resolveFiscalProvider(tenant)` returns `EtaFiscalProvider` for `"EG"`, else `NoopFiscalProvider`.

**Tech Stack:** Next.js (App Router — **read `node_modules/next/dist/docs/` before writing any route/page**, per `AGENTS.md`), Drizzle ORM + Postgres (RLS via `withTenant`, `src/db/with-tenant.ts`), `qrcode` (already a root dependency — server-side QR PNG generation), Vitest against a remote Supabase Postgres. Electron POS renderer (Vite) for `Receipt.tsx`.

## Global Constraints

- **The sale is authoritative and must never be blocked or rolled back by fiscal logic.** A missing tax code, an inactive config, or a dead ETA endpoint produces a `pending`/`failed` submission and an owner notification — never a failed or reversed sale.
- **No new arithmetic on money (F9).** Amounts are mapped from the existing `money(n)` numeric strings (`src/server/ordering/service.ts:55`); the sale's `orders.total` is the source of truth. `buildReceipt` only *reshapes* the numbers, it never recomputes them.
- **Secrets are never stored in a table row (F7).** `eta_tenant_config` holds `clientSecretRef`/`signingKeyRef` — env/secret-manager keys — resolved server-side at submit time. The config API returns `activationStatus` + masked identifiers only; it never echoes a secret.
- **All three tables are tenant-scoped, `ENABLE` + `FORCE ROW LEVEL SECURITY`,** with the house isolation policy `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` + matching `WITH CHECK`. Every read/write goes through `withTenant`. Drizzle does not emit RLS, so the policy block is hand-appended to the generated migration, exactly as `drizzle/0016_bitter_beast.sql` did.
- **One document per order/refund.** A partial unique index on `(tenantId, docType, orderId)` and `(tenantId, docType, refundId)` makes a retried enqueue a no-op, exactly as `pos_order_receipts` guarantees one sale.
- **Submission is a system action — no user permission (F8).** `fiscal:manage` (owner only) gates *config* and status reads; the worker submits with no RBAC grant, exactly as Spec 5 sending needs none.
- **`build*` are pure.** `buildReceipt`/`buildCreditNote` do no I/O and are unit-tested offline against fixtures. Only `submit` touches the network.
- **Depends on sibling specs (Specs 3/4/5).** This plan *calls* Spec 3 `issueRefund` (credit-note trigger), Spec 4 `recordAuditEvent`, and Spec 5 `notify`; it does not build any of them. Calls go through thin adapters (`src/server/fiscal/effects.ts`) that **degrade gracefully** — a no-op if the module is absent on the branch — mirroring how Spec 3 degrades when Spec 8 is absent. Assume Specs 4/5 land first; the adapters keep this PR green if they do not.
- Run `npx tsc --noEmit && npx eslint <files>` before every commit. Both must be clean.

---

## File Structure

**Database**
- Create: `src/server/fiscal/schema.ts` — `etaSubmissions`, `productTaxCodes`, `etaTenantConfig`; enums `eta_doc_type`, `eta_submission_status`, `eta_environment`, `eta_activation_status`.
- Modify: `src/db/schema.ts` — register the new schema barrel export.
- Create: `drizzle/00XX_*.sql` — generated migration; RLS policies + partial unique indexes hand-appended.

**Provider + pure types**
- Create: `src/server/fiscal/provider.ts` — `FiscalProvider`, `FiscalDocument`, `FiscalSaleInput`, `FiscalRefundInput`, `FiscalSubmitResult`, `EtaConfig`.
- Create: `src/server/fiscal/noop-provider.ts` — `NoopFiscalProvider`.
- Create: `src/server/fiscal/index.ts` — re-exports + `resolveFiscalProvider(tenant)`.
- Test: `src/server/fiscal/provider.test.ts` (fake provider, resolver, noop).

**Document builder + ETA provider**
- Create: `src/server/fiscal/build-document.ts` — `buildReceipt`, `buildCreditNote` (pure).
- Test: `src/server/fiscal/build-document.test.ts`.
- Create: `src/server/fiscal/eta-provider.ts` — `EtaFiscalProvider` (build delegates to `build-document`; `submit` = signed HTTP call, **wire format Blocked**).
- Create: `src/server/fiscal/config.ts` — `resolveEtaConfig(tenantId)` (secret-ref resolution).
- Test: `src/server/fiscal/eta-provider.test.ts`.

**Enqueue + wiring**
- Create: `src/server/fiscal/enqueue.ts` — `enqueueFiscalDocument(ctx, input, tx?)`, `isFiscalEnabled(tenantId)`.
- Create: `src/server/fiscal/effects.ts` — `recordFiscalAudit`, `notifyFiscalFailure` (Spec 4/5 adapters, degrade gracefully).
- Test: `src/server/fiscal/enqueue.test.ts`.
- Modify: `src/server/pos/record-sale.ts` — after-commit `e_receipt` enqueue (EG gate).
- Modify: Spec 3 `issueRefund` — `credit_note` enqueue (documented hook; degrades if Spec 3 absent).

**Worker**
- Create: `src/server/fiscal/worker.ts` — `drainEtaSubmissions()`.
- Test: `src/server/fiscal/worker.test.ts`.

**Authorization + config + read surfaces**
- Modify: `src/server/rbac/permissions.ts` — add `fiscal:manage` (owner only).
- Test: `src/server/rbac/permissions.test.ts`.
- Create: `src/server/fiscal/config-service.ts` — `getFiscalConfig`, `updateFiscalConfig` (masked), `getSaleFiscalStatus`.
- Create: `src/app/dashboard/fiscal-permission.ts` — `requireFiscalPermission`.
- Create: `src/app/api/dashboard/fiscal/config/route.ts` — GET/PUT.
- Create: `src/app/api/pos/v1/sales/[orderId]/fiscal/route.ts` — GET status (device-auth, `pos:sell`).
- Create: `src/app/dashboard/fiscal/page.tsx` — owner config + submission-status view.

**Renderer**
- Modify: `apps/pos/src/screens/Receipt.tsx` — fiscal footer (UUID + QR / pending / rejected).

---

## Task 1: Schema — `eta_submissions` + `product_tax_codes` + `eta_tenant_config`

Three tenant-scoped tables with FORCE RLS. `eta_submissions` deliberately mirrors Spec 5's `notification_outbox` (`status` + `attempts` + `lastError`) so the same store-and-forward worker semantics apply.

**Files:**
- Create: `src/server/fiscal/schema.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/00XX_*.sql` (generated, then edited)

**Interfaces:**
- Produces: tables `etaSubmissions`, `productTaxCodes`, `etaTenantConfig`; enums `etaDocTypeEnum` (`e_receipt | e_invoice | credit_note`), `etaSubmissionStatusEnum` (`pending | submitted | accepted | rejected | failed`), `etaEnvironmentEnum` (`preprod | prod`), `etaActivationStatusEnum` (`not_configured | pending | active | suspended`); types `EtaSubmission`, `ProductTaxCode`, `EtaTenantConfig`.

- [x] **Step 0 (added 2026-08-30): include the addendum §2 deltas** — enum gains `return_receipt`; add `eta_device_chains` + `eta_pos_credentials` tables; `product_tax_codes` gains `codeSource`/`egsApprovalStatus`; `eta_submissions` gains `referenceOldUuid`. The code block below predates the addendum — extend it accordingly.

- [x] **Step 1: Write the schema.** Create `src/server/fiscal/schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, integer, jsonb, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { orders } from "@/server/ordering/schema";
import { products } from "@/server/catalog/schema";
// NOTE: refunds (Spec 3) — reference by column only; do not import if the schema
// is not yet on the branch. Add the FK when Spec 3's schema.ts exists.

export const etaDocTypeEnum = pgEnum("eta_doc_type", ["e_receipt", "e_invoice", "credit_note"]);
export const etaSubmissionStatusEnum = pgEnum("eta_submission_status", ["pending", "submitted", "accepted", "rejected", "failed"]);
export const etaEnvironmentEnum = pgEnum("eta_environment", ["preprod", "prod"]);
export const etaActivationStatusEnum = pgEnum("eta_activation_status", ["not_configured", "pending", "active", "suspended"]);

/**
 * One row per fiscal document sent (or to be sent) to ETA. Created `pending`,
 * drained + retried by drainEtaSubmissions, terminal at accepted/rejected.
 * requestJson/responseJson are forensics + resubmit material.
 */
export const etaSubmissions = pgTable("eta_submissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  docType: etaDocTypeEnum("doc_type").notNull(),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),   // e_receipt / e_invoice
  refundId: uuid("refund_id"),                                                       // credit_note (Spec 3 FK added later)
  status: etaSubmissionStatusEnum("status").notNull().default("pending"),
  etaUuid: text("eta_uuid"),
  etaLongId: text("eta_long_id"),
  submissionUuid: text("submission_uuid"),
  qrPayload: text("qr_payload"),
  hashOrSignature: text("hash_or_signature"),
  requestJson: jsonb("request_json").$type<Record<string, unknown>>().notNull().default({}),
  responseJson: jsonb("response_json").$type<Record<string, unknown>>(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("eta_submissions_claim").on(t.status, t.createdAt),
  uniqueIndex("eta_submissions_order").on(t.tenantId, t.docType, t.orderId).where(sql`${t.orderId} is not null`),
  uniqueIndex("eta_submissions_refund").on(t.tenantId, t.docType, t.refundId).where(sql`${t.refundId} is not null`),
]);

/** Per-product fiscal classification ETA requires on every line. */
export const productTaxCodes = pgTable("product_tax_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  egsCode: text("egs_code").notNull(),        // EGS (GS1 Egypt) / GPC item code
  taxType: text("tax_type").notNull(),        // ETA tax type — see Blocked item 4 (code list)
  taxSubType: text("tax_sub_type"),
  unitType: text("unit_type").notNull(),      // ETA unit-of-measure code
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("product_tax_codes_product").on(t.tenantId, t.productId)]);

/** One row per EG tenant: registration + credential REFERENCES + environment. */
export const etaTenantConfig = pgTable("eta_tenant_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().unique().references(() => tenants.id, { onDelete: "cascade" }),
  registrationNumber: text("registration_number").notNull(),  // taxpayer RIN
  clientId: text("client_id").notNull(),
  clientSecretRef: text("client_secret_ref").notNull(),        // reference, NEVER the secret (F7)
  signingKeyRef: text("signing_key_ref"),                      // e-seal material ref (nullable)
  environment: etaEnvironmentEnum("environment").notNull().default("preprod"),
  activationStatus: etaActivationStatusEnum("activation_status").notNull().default("not_configured"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EtaSubmission = typeof etaSubmissions.$inferSelect;
export type ProductTaxCode = typeof productTaxCodes.$inferSelect;
export type EtaTenantConfig = typeof etaTenantConfig.$inferSelect;
```

- [x] **Step 2: Register it.** Append to `src/db/schema.ts` (after the `pos/tender-schema` line):

```ts
export * from "../server/fiscal/schema";
```

- [x] **Step 3: Generate the migration.** `npm run db:generate`. Expected: a new `drizzle/00XX_*.sql` with the four enums, three tables, FKs, and the non-partial indexes. It will **not** contain RLS or the partial-index `WHERE`.

- [x] **Step 4: Hand-append RLS.** Open the generated file and append (mirror `drizzle/0016_bitter_beast.sql:67-71`) an `ENABLE` + `FORCE` + `CREATE POLICY <table>_isolation` block for each of `eta_submissions`, `product_tax_codes`, `eta_tenant_config`. Verify the two partial `uniqueIndex … WHERE … is not null` statements are present (Drizzle emits `.where()`; if not, add the `WHERE` by hand).

- [x] **Step 5: Apply and verify the existing suite still passes.** `npm run db:migrate:test && npm test`. Expected: migration applies; full suite PASS (nothing references the new tables yet).

- [x] **Step 6: Commit.**

```bash
git add src/server/fiscal/schema.ts src/db/schema.ts drizzle/
git commit -m "feat(fiscal): eta_submissions + product_tax_codes + eta_tenant_config with FORCE RLS"
```

---

## Task 2: `FiscalProvider` interface + `NoopFiscalProvider` + resolver

The abstraction, shaped exactly like `BillingProvider` (`src/server/billing/provider.ts`): a tiny `interface` (`readonly name` + methods), concrete impls behind it, a clean `index.ts` re-export. `build*` are pure; `submit` is async. `resolveFiscalProvider(tenant)` picks ETA for `"EG"`, else the no-op. This task ships the interface, the no-op, the resolver, and the shared pure types — tested with a **fake provider** so the contract is proven with zero ETA detail.

**Files:**
- Create: `src/server/fiscal/provider.ts`
- Create: `src/server/fiscal/noop-provider.ts`
- Create: `src/server/fiscal/index.ts`
- Test: `src/server/fiscal/provider.test.ts`

**Interfaces:**
- Produces:
  - `type FiscalDocLine = { egsCode: string; taxType: string; taxSubType: string | null; unitType: string; description: string; quantity: number; unitPrice: string; lineTotal: string }`
  - `type FiscalDocument = { docType: "e_receipt" | "e_invoice" | "credit_note"; referenceUuid: string | null; lines: FiscalDocLine[]; total: string; currency: string; issuedAt: string }`
  - `type FiscalSaleInput` / `FiscalRefundInput` — the sale/refund + its resolved `ProductTaxCode[]`.
  - `type FiscalSubmitResult = { status: "accepted" | "rejected" | "submitted" | "skipped"; etaUuid?: string; etaLongId?: string; submissionUuid?: string; qrPayload?: string; hashOrSignature?: string; responseJson: Record<string, unknown> }`
  - `type EtaConfig = { registrationNumber: string; clientId: string; clientSecret: string; signingKey: string | null; environment: "preprod" | "prod" }` (secrets **resolved**, in memory only).
  - `interface FiscalProvider { readonly name: string; buildReceipt(input): FiscalDocument; buildCreditNote(input): FiscalDocument; submit(doc, cfg): Promise<FiscalSubmitResult>; }`
  - `class NoopFiscalProvider` — `name = "noop"`; `build*` throw (never called for non-EG); `submit` returns `{ status: "skipped", responseJson: {} }`.
  - `function resolveFiscalProvider(tenant: Pick<Tenant, "country">): FiscalProvider`.

- [x] **Step 1: Write the failing tests.** Create `src/server/fiscal/provider.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { NoopFiscalProvider } from "./noop-provider";
import { resolveFiscalProvider } from "./index";
import type { FiscalProvider, FiscalDocument, FiscalSubmitResult, EtaConfig } from "./provider";

/** A fake provider proving the contract with zero ETA detail. */
class FakeFiscalProvider implements FiscalProvider {
  readonly name = "fake";
  buildReceipt(): FiscalDocument { return { docType: "e_receipt", referenceUuid: null, lines: [], total: "0.00", currency: "EGP", issuedAt: "2026-07-24T00:00:00.000Z" }; }
  buildCreditNote(): FiscalDocument { return { docType: "credit_note", referenceUuid: "PARENT", lines: [], total: "0.00", currency: "EGP", issuedAt: "2026-07-24T00:00:00.000Z" }; }
  async submit(): Promise<FiscalSubmitResult> { return { status: "accepted", etaUuid: "UUID-1", qrPayload: "QR", responseJson: {} }; }
}

describe("resolveFiscalProvider", () => {
  it("returns an ETA provider for EG", () => {
    expect(resolveFiscalProvider({ country: "EG" }).name).toBe("eta");
  });
  it("returns the no-op provider for a non-EG tenant", () => {
    expect(resolveFiscalProvider({ country: "SA" }).name).toBe("noop");
  });
});

describe("NoopFiscalProvider", () => {
  it("submit returns skipped and writes nothing", async () => {
    const res = await new NoopFiscalProvider().submit({} as FiscalDocument, {} as EtaConfig);
    expect(res.status).toBe("skipped");
  });
});

describe("FiscalProvider contract (fake)", () => {
  it("a conforming provider builds and submits", async () => {
    const p = new FakeFiscalProvider();
    expect(p.buildReceipt({} as never).docType).toBe("e_receipt");
    expect(p.buildCreditNote({} as never).referenceUuid).toBe("PARENT");
    expect((await p.submit({} as FiscalDocument, {} as EtaConfig)).status).toBe("accepted");
  });
});
```

- [x] **Step 2: Run to verify they fail.** `npx vitest run src/server/fiscal/provider.test.ts`. Expected: FAIL — module not found.

- [x] **Step 3: Implement.** Create `src/server/fiscal/provider.ts` (the types + interface above), `src/server/fiscal/noop-provider.ts` (`NoopFiscalProvider`), and `src/server/fiscal/index.ts`:

```ts
import type { Tenant } from "@/server/tenancy/schema";
import type { FiscalProvider } from "./provider";
import { NoopFiscalProvider } from "./noop-provider";
import { EtaFiscalProvider } from "./eta-provider"; // Task 3

export * from "./provider";
export { NoopFiscalProvider } from "./noop-provider";
export { EtaFiscalProvider } from "./eta-provider";

const eta = new EtaFiscalProvider();
const noop = new NoopFiscalProvider();

/** One provider per request, chosen from the tenant's country (F1/F2). */
export function resolveFiscalProvider(tenant: Pick<Tenant, "country">): FiscalProvider {
  return tenant.country === "EG" ? eta : noop;
}
```

Note: `index.ts` imports `EtaFiscalProvider` from Task 3 — implement a minimal stub class there first (name `"eta"`, `build*`/`submit` throwing `"not implemented"`) so this task compiles, then fill it in Task 3.

- [x] **Step 4: Run to verify they pass.** `npx vitest run src/server/fiscal/provider.test.ts && npx tsc --noEmit`. Expected: PASS, clean.

- [x] **Step 5: Commit.**

```bash
git add src/server/fiscal/provider.ts src/server/fiscal/noop-provider.ts src/server/fiscal/index.ts src/server/fiscal/provider.test.ts src/server/fiscal/eta-provider.ts
git commit -m "feat(fiscal): FiscalProvider interface, NoopFiscalProvider, country-gated resolver"
```

---

## Task 3: Fiscal document builder + `EtaFiscalProvider`

The **pure** mappers that turn a sale/refund into a `FiscalDocument` using the resolved `product_tax_codes`. A line whose product has **no** tax code cannot be built — the builder throws `MissingTaxCodeError(productId)`, which the worker turns into a `failed` row + owner alert (never a blocked sale). `buildCreditNote` negates the returned lines and carries the parent's `etaUuid` in `referenceUuid`. Money is mapped from `money(n)` strings — **no new arithmetic (F9)**. `EtaFiscalProvider.build*` delegate here; `EtaFiscalProvider.submit` is the signed HTTP call whose exact wire format is **Blocked** (see final section) — implement the OAuth2 client-credentials call skeleton + result mapping and mark the payload shape `TODO(VERIFY)`.

**Files:**
- Create: `src/server/fiscal/build-document.ts`
- Create: `src/server/fiscal/eta-provider.ts` (replace the Task 2 stub)
- Create: `src/server/fiscal/config.ts`
- Test: `src/server/fiscal/build-document.test.ts`
- Test: `src/server/fiscal/eta-provider.test.ts`

**Interfaces:**
- Consumes: `ProductTaxCode` (Task 1); `FiscalDocument`, `FiscalSaleInput`, `FiscalRefundInput`, `EtaConfig`, `FiscalSubmitResult` (Task 2); `money`/`OrderItem` shapes (`src/server/ordering`).
- Produces:
  - `class MissingTaxCodeError extends Error` — carries `productId`.
  - `function buildReceipt(input: FiscalSaleInput): FiscalDocument`
  - `function buildCreditNote(input: FiscalRefundInput): FiscalDocument`
  - `function resolveEtaConfig(tenantId: string): Promise<EtaConfig | null>` — reads `eta_tenant_config` via `withTenant`, resolves `clientSecretRef`/`signingKeyRef` from `process.env` (or secret manager), returns `null` when `activationStatus !== "active"`.
  - `class EtaFiscalProvider implements FiscalProvider`.

- [x] **Step 1: Write the failing builder tests. (3a)** Create `src/server/fiscal/build-document.test.ts` — pure, no DB. Assert:
  - `buildReceipt` maps each order line to a `FiscalDocLine` with the correct `egsCode`/`taxType`/`taxSubType`/`unitType` from the supplied `product_tax_codes`, and the document `total` equals the sale's `orders.total` **to the cent** for a fixture with a discount, VAT, and a service charge (money-mapping parity, F9).
  - a line whose product has no tax code throws `MissingTaxCodeError` naming that `productId`.
  - `buildCreditNote` sets `referenceUuid` to the parent's `etaUuid`, negates each returned line's amount, and totals only the refunded lines/amount (not the whole receipt).

```ts
import { describe, it, expect } from "vitest";
import { buildReceipt, buildCreditNote, MissingTaxCodeError } from "./build-document";

const taxCode = (productId: string) => ({
  productId, egsCode: "EG-100", taxType: "T1", taxSubType: null, unitType: "EA",
} as never);

describe("buildReceipt", () => {
  it("maps lines with EGS/tax/unit and totals to the cent (F9 parity)", () => {
    const doc = buildReceipt({
      order: { id: "o1", total: "115.00", vatAmount: "15.00", serviceChargeAmount: "0", currency: "EGP", placedAt: "2026-07-24T10:00:00.000Z" },
      items: [{ productId: "p1", nameEn: "Burger", quantity: 2, lineTotal: "100.00", unitBasePrice: "50.00" }],
      taxCodes: [taxCode("p1")],
    } as never);
    expect(doc.docType).toBe("e_receipt");
    expect(doc.total).toBe("115.00");
    expect(doc.lines[0]).toMatchObject({ egsCode: "EG-100", taxType: "T1", unitType: "EA", quantity: 2 });
  });

  it("throws MissingTaxCodeError for an unclassified line", () => {
    expect(() => buildReceipt({
      order: { id: "o1", total: "50.00", currency: "EGP", placedAt: "2026-07-24T10:00:00.000Z" },
      items: [{ productId: "p-unclassified", nameEn: "X", quantity: 1, lineTotal: "50.00", unitBasePrice: "50.00" }],
      taxCodes: [],
    } as never)).toThrow(MissingTaxCodeError);
  });
});

describe("buildCreditNote", () => {
  it("references the parent UUID and negates the returned lines", () => {
    const doc = buildCreditNote({
      parentEtaUuid: "PARENT-UUID",
      refund: { id: "r1", totalAmount: "50.00", currency: "EGP", createdAt: "2026-07-24T11:00:00.000Z" },
      lines: [{ productId: "p1", quantity: 1, amount: "50.00" }],
      taxCodes: [taxCode("p1")],
    } as never);
    expect(doc.docType).toBe("credit_note");
    expect(doc.referenceUuid).toBe("PARENT-UUID");
    expect(doc.total).toBe("-50.00");
  });
});
```

- [x] **Step 2: Run to verify they fail. (3a)** `npx vitest run src/server/fiscal/build-document.test.ts`. Expected: FAIL — module not found.

- [x] **Step 3: Implement the builder. (3a)** Create `src/server/fiscal/build-document.ts` — a `Map<productId, ProductTaxCode>` lookup; map each line; throw `MissingTaxCodeError` on a miss; carry `money(n)` strings verbatim (prefix `-` for credit-note amounts); set `docType`, `referenceUuid`, `total`, `currency`, `issuedAt`. **No `Number()` re-summation of the sale total** — take `order.total` / `refund.totalAmount` straight through.

  **(3a) as-built — see the addendum §6 for the verified sources behind each point.** (1) Amounts are **not** negated: Return Receipt v1.2 publishes no negative-amount convention; a return is identified by `documentType.receiptType = "r"` plus the Mandatory `referenceUUID`. (2) Fees are **receipt lines**, not a fees slot: v1.2's `feesAmount`/`adjustment` "accept only zero values", so `serviceChargeAmount`/`deliveryFee` each become their own `itemData` line from a per-tenant `FeeLineConfig` (`FeeLineConfigMissingError` when unconfigured). (3) `orders.vatAmount` is **allocated per line** by largest remainder over scaled BigInt, because ETA validates tax per line; the order-level discount rides down onto the lines with it, and both ETA equations (`totalAmount`, `taxTotals`) are enforced on the emitted document. (4) 3a also delivered the wire layer the plan folded into Step 4: `eta-wire.ts` (receipt v1.2 JSON + `WireContext`), `serialize.ts` (ETA's canonical serialization, verified byte-for-byte against their published worked example, plus the SHA-256 uuid chain and QR url) and `decimal.ts` (exact decimal arithmetic, so `money(n)` literals survive hashing). Step 4 keeps only the HTTP/config half.

- [x] **Step 4: Implement `EtaFiscalProvider` + `resolveEtaConfig`. (3b)** In `src/server/fiscal/eta-provider.ts`, `build*` delegate to the builder; `submit(doc, cfg)` obtains an OAuth2 client-credentials token, POSTs the document, and maps the response to `FiscalSubmitResult` (`accepted` → `etaUuid`/`etaLongId`/`qrPayload`; `rejected` → `responseJson` + errors). **Mark the request-body shape, signing, and `qrPayload` decoding `TODO(VERIFY)` per the Blocked section** — do not invent the field names. Create `src/server/fiscal/config.ts` with `resolveEtaConfig` reading the row via `withTenant` and resolving secret refs from `process.env`, returning `null` unless `activationStatus === "active"`.

  **(3b) as-built — the request/response shapes are no longer `TODO(VERIFY)`: every one was read off ETA's own SDK pages plus their published Postman collection, and each is cited at its use site.** (1) `eta-env.ts` holds the one preprod/prod map (identity / API / portal bases, verbatim from the FAQ's URL table) plus the preprod TLS seam — `NODE_EXTRA_CA_CERTS`, because `undici` is not importable here so `fetch` cannot be handed a per-request CA; disabling verification is documented as forbidden. (2) Token client: POS login sends the four documented headers (`posserial`/`pososversion`/`posmodelframework`/`presharedkey`) with `grant_type`/`client_id`/`client_secret` form-encoded and no scope; the ERP login uses RFC 2617 Basic with `grant_type`+`scope`. Tokens are cached per `environment|clientId|posSerial` in process memory only, with a 60s renewal margin, and a 401 forces exactly one re-login. (3) `submit` posts `{"receipts":[<doc>]}` via `stringifyWire` (never `JSON.stringify`, which would destroy the decimal literals the uuid was hashed over); **`signatures` is deliberately omitted** — the page requires an issuer signature but also says validation "will not be deployed at this point", and every ETA Postman sample omits it, so the element is a seam rather than a fabricated value (VERIFY 2 still open). A 202 maps to `"submitted"` (it is "accepted for further processing", not a verdict) carrying `submissionUUID`/`longId`; a document in `rejectedDocuments` maps to the terminal `"rejected"`. (4) `poll` maps `InProgress`→`submitted`, `Valid`→`accepted`, `Invalid`→`rejected`, `Cancelled`→`accepted`, and refuses to guess at any undocumented status. (5) New `eta-transport-errors.ts`: `EtaTransportError` (RETRYABLE — carries status, `Retry-After` seconds, ETA error code, correlation id, redacted body) and `EtaConfigError` (PERMANENT config fault), both deliberately outside the `FiscalDocumentError` family. A device missing its pre-shared key fails fast as `EtaConfigError` instead of sending an incomplete login.

- [x] **Step 5: Write + run the ETA provider tests. (3b)** Create `src/server/fiscal/eta-provider.test.ts`: `buildReceipt`/`buildCreditNote` produce the expected shape from fixtures (reuses the builder); `submit` is tested against a **mocked** HTTP layer asserting the accepted/rejected result mapping only (no real ETA call, no asserted wire format — that is Blocked). `resolveEtaConfig` returns `null` for a non-active tenant.

  **(3b) as-built:** `eta-provider.test.ts` (24 tests) mocks at the `fetch` boundary with real `Response` objects, so header assembly, form encoding and status handling are exercised for real — POS header/body encoding, token cache hit, re-auth after `expires_in` elapses, `invalid_posserial` → `EtaConfigError`, envelope snapshot, 202/immediate-rejection mapping, 429 with `retryAfterSeconds`, 503/500, network failure, 401 renewal, and the full poll matrix. Every result and error asserts that no bearer token, client secret or pre-shared key reached `responseJson`. `config.test.ts` (16 tests) runs against the real test Postgres, seeding through `withTenant`: active resolution, every inactive `activationStatus`, every unusable device status, `env://` and bare ref spellings, a missing env ref → typed `EtaConfigError`, and RLS isolation (unfiltered cross-tenant reads and unscoped reads both see nothing). The two pre-3b "still throws not implemented" placeholders in `provider.test.ts`/`build-document.test.ts` were replaced/removed, since 3b is what implements them.

Run: `npx vitest run src/server/fiscal/build-document.test.ts src/server/fiscal/eta-provider.test.ts && npx tsc --noEmit`. Expected: PASS, clean.

- [x] **Step 6: Commit. (3b)** 3a committed the pure builder/wire/serialize half; 3b commits the transport half as `feat(fiscal): ETA transport — POS token client, submit/poll, env map + config resolution`.

```bash
git add src/server/fiscal/eta-env.ts src/server/fiscal/eta-transport-errors.ts src/server/fiscal/eta-provider.ts src/server/fiscal/config.ts src/server/fiscal/eta-provider.test.ts src/server/fiscal/config.test.ts
git commit -m "feat(fiscal): ETA transport — POS token client, submit/poll, env map + config resolution"
```

---

## Task 4: `enqueueFiscalDocument` + wire into `recordSale` and refunds

The core non-HTTP surface. `enqueueFiscalDocument` inserts a `pending` `eta_submissions` row; the unique index makes a retried enqueue a no-op (`onConflictDoNothing`). It accepts an optional `tx`: **inside** the caller's transaction for the refund path (atomic with the refund), or opens its own `withTenant` for the sale path (called **after** `recordSale`'s sale has fully committed, so ETA never blocks a sale). `isFiscalEnabled(tenantId)` reads `tenants.country === "EG"` — the gate.

**Files:**
- Create: `src/server/fiscal/enqueue.ts`
- Create: `src/server/fiscal/effects.ts`
- Modify: `src/server/pos/record-sale.ts`
- Modify: Spec 3 `issueRefund` (`src/server/pos/refunds/service.ts` or wherever Spec 3 lands) — **as-built: `src/server/pos/refund.ts`**, already on this branch.
- Test: `src/server/fiscal/enqueue.test.ts`

**Interfaces:**
- Consumes: `etaSubmissions` (Task 1); `resolveFiscalProvider` (Task 2); `withTenant`; `tenants`.
- Produces:
  - `type EnqueueInput = { docType: "e_receipt" | "e_invoice" | "credit_note"; orderId?: string; refundId?: string }` — **as-built: a discriminated union, not an optional-fields bag** — `{ docType: "e_receipt" | "e_invoice"; orderId: string } | { docType: "return_receipt" | "credit_note"; refundId: string }` (`return_receipt` per the addendum — see Step 5's as-built note), so the parent XOR the `eta_submissions_parent_xor` CHECK enforces in the DB is unrepresentable-wrong at the type level too.
  - `function isFiscalEnabled(tenantId: string): Promise<boolean>`
  - `function enqueueFiscalDocument(ctx: { tenantId: string }, input: EnqueueInput, tx?: Tx): Promise<void>`
  - `effects.ts`: `recordFiscalAudit(...)`, `notifyFiscalFailure(...)` — thin adapters that call Spec 4 `recordAuditEvent` / Spec 5 `notify`. **As-built: no "if present, else no-op" indirection** — Specs 4/5 are both already on this branch, so effects.ts imports them directly (see Step 3's as-built note).

- [x] **Step 1: Write the failing tests.** Create `src/server/fiscal/enqueue.test.ts`:
  - An **EG** sale enqueues exactly one `pending e_receipt` for its `orderId`.
  - A **non-EG** sale enqueues **none** (country gate — the load-bearing test in the spec's Testing section).
  - A **re-enqueue** for the same `(orderId, docType)` is a **no-op** (unique index) — still exactly one row.
  - Enqueue **inside a tx that then throws** leaves **no** row (rolls back with the caller) — the refund-path atomicity guarantee.

Seed tenants with `country: "EG"` / `"SA"` following `src/server/fiscal/provider.test.ts` and the audit plan's `seedTenant` shape.

  **as-built (2026-08-31):** the review-mandated regression pin added a fifth and sixth case beyond the four above: a **rejected-original re-enqueue** is still a no-op (the `eta_submissions_order_original`/`_refund_original` partial index ignores `status` — see schema.ts's JSDoc), and **`issueRefund` on an EG tenant** enqueues exactly one pending `return_receipt` atomically with the refund (non-EG: none). `seedPosContext` (src/server/pos/test-helpers.ts) always seeds an `"EG"` tenant, so it doubles as the EG fixture; non-EG cases flip `tenants.country` directly post-seed (a plain, non-RLS control table) rather than duplicating the fixture.

- [x] **Step 2: Run to verify they fail.** `npx vitest run src/server/fiscal/enqueue.test.ts`. Expected: FAIL — module not found.

- [x] **Step 3: Implement `enqueueFiscalDocument`.** Create `src/server/fiscal/enqueue.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { etaSubmissions } from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function isFiscalEnabled(tenantId: string): Promise<boolean> {
  const [t] = await db.select({ country: tenants.country }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return t?.country === "EG";
}

export type EnqueueInput = { docType: "e_receipt" | "e_invoice" | "credit_note"; orderId?: string; refundId?: string };

/**
 * Inserts a `pending` submission. NO network call — a cheap durable write.
 * Idempotent via the partial unique index (onConflictDoNothing). Runs on the
 * caller's tx when passed (refund path, atomic), else opens its own withTenant
 * (sale path, after the sale committed).
 */
export async function enqueueFiscalDocument(ctx: { tenantId: string }, input: EnqueueInput, tx?: Tx): Promise<void> {
  const run = (t: Tx) => t.insert(etaSubmissions).values({
    tenantId: ctx.tenantId, docType: input.docType,
    orderId: input.orderId ?? null, refundId: input.refundId ?? null,
    status: "pending", attempts: 0, requestJson: {},
  }).onConflictDoNothing();
  if (tx) { await run(tx); return; }
  await withTenant(ctx.tenantId, run);
}
```

  **as-built (2026-08-31):** the sketch above predates the addendum and a Task 1 review; four deltas. (1) `EnqueueInput` is the discriminated union from the Interfaces note above, not `{ orderId?, refundId? }` — `enqueueFiscalDocument` narrows on `input.docType` via a `switch` (TypeScript does not narrow a multi-literal discriminant through an `||`-joined `if`/ternary, nor through a nested closure that captures the already-narrowed parameter — both were tried and both fail `tsc`; the values/target/where are resolved to concrete, non-union locals *before* the `run(t: Tx)` closure is defined). (2) Idempotency targets the ORIGINAL-document partial indexes by name (`eta_submissions_order_original` / `_refund_original`), not a bare `.onConflictDoNothing()` — those indexes hold `status`-independent uniqueness. **Correction (2026-08-31 review): the failure mode of targeting the wrong index is not a graceful collide-on-duplicate.** Targeting the plan's original `eta_submissions_order`/`_refund` pair instead (status-dependent: `WHERE status <> 'rejected'`) as the arbiter means a blind re-enqueue over an already-*rejected* row does not MATCH that arbiter at all — the existing row is excluded from its `status <> 'rejected'` scope, so as far as that index is concerned there is nothing to conflict with. The insert then proceeds past the `ON CONFLICT` guard and hard-fails with a `23505 unique_violation` against the still-live, status-independent `eta_submissions_order_original` index, which does still see it as a duplicate — an unhandled error, not a silent no-op. Load-bearing test note: the plain re-enqueue test (same-status duplicate) passes under EITHER arbiter, since the existing row there is not rejected and both indexes agree it is a live duplicate — only the rejected-original re-enqueue test discriminates a correctly-chosen arbiter from a wrong one, which is why it is the regression pin, not the plain duplicate test. (3) The conflict target's `where` must reproduce the index's exact predicate (`... is not null and reference_old_uuid is null`) or Postgres cannot infer the arbiter. **The plan text (and this task's own brief) called this drizzle option `targetWhere`; on the installed drizzle-orm 0.45.2, `onConflictDoNothing`'s config type is `{ target?, where? }` only — `targetWhere` exists solely on `onConflictDoUpdate`'s config type (verified directly against `node_modules/drizzle-orm/pg-core/query-builders/insert.d.ts`/`.js`).** Passing `where` renders identically (`(target) where <predicate> do nothing`) to what `targetWhere` would if it existed here — this is a naming correction, not a behavior change, but a literal `targetWhere` key would have been silently dropped (TS would in fact reject it as an excess property) rather than applying the predicate. (4) `tenantId`/`docType` are included in the conflict `target` column list (matching the index's actual columns), not just `orderId`/`refundId` alone.

- [x] **Step 4: Wire `recordSale`.** In `src/server/pos/record-sale.ts`, import `enqueueFiscalDocument` + `isFiscalEnabled`. **After** the final `db.insert(posOrderReceipts)` (the sale is fully done — line 176-181), before `return { … }`, add a non-blocking enqueue guarded by the EG gate. Wrap in try/catch that only logs — **a fiscal enqueue failure must never fail the sale**:

```ts
  // Fiscal (Spec 11): the sale is committed and returned regardless. EG tenants
  // enqueue a pending e_receipt; the worker submits to ETA asynchronously. A
  // non-EG tenant writes nothing (country gate, F2).
  try {
    if (!existing && await isFiscalEnabled(ctx.tenantId)) {
      await enqueueFiscalDocument({ tenantId: ctx.tenantId }, { docType: "e_receipt", orderId: placed.orderId });
    }
  } catch (err) {
    console.error("fiscal enqueue failed (sale unaffected)", err);
  }
```

The `SaleReceipt` return value is **unchanged**; the POS reads fiscal status separately via the Task 6 endpoint.

  **as-built (2026-08-31):** `record-sale.ts` does not return inline (recordSale wraps its work in `placeOrder`'s `onPlaced` callback, itself inside `placeOrder`'s own transaction — the plan's flat "line 176-181, before `return { … }`" shape predates that structure). The enqueue is placed after `const placed = await placeOrder(...)` resolves — i.e. after `placeOrder`'s transaction has *actually* committed (`onPlaced` still runs mid-transaction, so calling the sale-path, own-`withTenant` `enqueueFiscalDocument` from inside it would open a second transaction while the first was still open) — and before the function's real final `return committedReceipt!;`. Same gate, same non-blocking try/catch, same `!existing` guard (`existing` is in closure scope from the idempotency check at the top of `recordSale`; always true structurally at this point, since a truthy `existing` returns early before `placeOrder` is ever called — kept explicit anyway per this task's brief, as a stated invariant rather than a live branch).

- [x] **Step 5: Wire the refund path (Spec 3).** In Spec 3's `issueRefund`, **inside** its existing `withTenant` transaction (after the `refunds`/`refund_lines`/`refund_payments` insert, alongside its `recordAuditEvent`), when `isFiscalEnabled(tenantId)`, call `enqueueFiscalDocument({ tenantId }, { docType: "credit_note", refundId }, tx)` so the credit-note enqueue commits atomically with the refund. If Spec 3 is not yet on the branch, add a `// TODO(fiscal): enqueue credit_note here — see plan Task 4 Step 5` marker in the fiscal effects module and cover it once Spec 3 lands (note it in Self-Review).

  **as-built (2026-08-31): docType is `return_receipt`, not `credit_note`.** Spec 3 (`src/server/pos/refund.ts`) is already on this branch, so no TODO/degrade path was needed. Per the verified-findings addendum (§C4): on the e-receipt system a refund is a **Return Receipt** referencing the original receipt's UUID (within 540 days); `credit_note` stays reserved for the deferred B2B e-invoice correction and is never written by `issueRefund`. The enqueue call (`enqueueFiscalDocument({ tenantId: actor.tenantId }, { docType: "return_receipt", refundId: refund.id }, tx)`) sits immediately after the existing `recordAuditEvent` call (numbered step 10 in `issueRefund`'s own inline step comments) and before the transaction's `return`, exactly as this step describes — no try/catch, so a failed insert rolls the whole refund back with it (the refund has not yet been handed to a customer, unlike a completed sale).

- [x] **Step 6: Run tests + full suite.** `npx vitest run src/server/fiscal/enqueue.test.ts && npm test && npx tsc --noEmit && npx eslint src/server/fiscal src/server/pos`. Expected: PASS, clean; existing `record-sale.test.ts` still green (non-EG fixtures enqueue nothing; EG fixtures gain one row).

  **as-built (2026-08-31):** ran the scoped form (`npx vitest run src/server/pos/record-sale.test.ts src/server/pos/refund.test.ts src/server/fiscal/`) per this task's own instructions rather than the full `npm test` — 8 files / 203 tests passed (194 pre-existing + 9 new in `enqueue.test.ts`), plus the full `src/server/pos/` directory (20 files / 204 tests) as extra diligence since `record-sale.ts`/`refund.ts` are widely imported. `tsc --noEmit` and `eslint src/server/fiscal src/server/pos` both clean.

- [x] **Step 7: Commit.**

```bash
git add src/server/fiscal/enqueue.ts src/server/fiscal/effects.ts src/server/fiscal/enqueue.test.ts src/server/pos/record-sale.ts
git commit -m "feat(fiscal): enqueueFiscalDocument + non-blocking after-commit e_receipt/credit_note enqueue"
```

  **as-built (2026-08-31):** also stages `src/server/pos/refund.ts` (Step 5's wiring — not listed above, since the plan's sketch had it as a separate/deferred TODO). Actual commit message: `feat(fiscal): country-gated enqueue wired into recordSale + issueRefund (non-blocking sale, atomic refund)` — no `Co-Authored-By`/`Generated-with` trailers, per house convention.

---

## Task 5: `drainEtaSubmissions` — the async submission worker

Mirrors Spec 5's outbox worker. Claims `pending|failed` rows (`SELECT … FOR UPDATE SKIP LOCKED`, backoff-eligible), resolves `EtaConfig`, builds → signs → `submit`s, records `etaUuid`/`qrPayload`/`status`, increments `attempts` with exponential backoff, and on terminal failure raises a Spec 5 `critical` notification. Idempotent per row: `submissionUuid` is written before `accepted`, so a reclaim re-queries rather than blindly re-sending (**exact resubmit/idempotency semantics are Blocked** — see final section; implement the guard, mark the ETA-side dedupe key `TODO(VERIFY)`). A `credit_note` whose parent `e_receipt` has no `etaUuid` yet is **deferred**, never submitted as an orphan.

**Files:**
- Create: `src/server/fiscal/worker.ts`
- Test: `src/server/fiscal/worker.test.ts`

**Interfaces:**
- Consumes: `etaSubmissions`, `productTaxCodes` (Task 1); `resolveFiscalProvider` (Task 2); `buildReceipt`/`buildCreditNote`, `resolveEtaConfig`, `MissingTaxCodeError` (Task 3); `recordFiscalAudit`/`notifyFiscalFailure` (Task 4 effects).
- Produces:
  - `const MAX_ATTEMPTS = 6` (or config).
  - `function drainEtaSubmissions(opts?: { provider?: FiscalProvider; limit?: number }): Promise<{ processed: number }>` — `provider` injectable so tests pass a **fake**.

- [ ] **Step 1: Write the failing tests.** Create `src/server/fiscal/worker.test.ts`, injecting a stubbed provider (accept / reject / throw variants):
  - **Accept:** a `pending e_receipt` → the worker records `etaUuid`/`qrPayload`, sets `status='accepted'` + `acceptedAt`, and emits the `eta.submission.accepted` audit event.
  - **Reject:** the provider returns `rejected` → `status='rejected'`, `responseJson` captured, `lastError` set, owner notified, and `eta.submission.rejected` emitted. The sale stands.
  - **Transient error:** the provider throws → `attempts++`, `status='failed'`, backoff set; after `MAX_ATTEMPTS` the row stays `failed` and a Spec 5 `critical` `notify` fires **once**.
  - **Missing tax code:** a line with no `product_tax_codes` row → `MissingTaxCodeError` → `status='failed'` with a product-naming `lastError`; the **sale is untouched** (assert the order + tenders are unchanged).
  - **Concurrency:** two `drainEtaSubmissions` runs over the same row submit it **exactly once** (`SKIP LOCKED`).
  - **Credit-note deferral:** a `credit_note` whose parent receipt is not yet `accepted` is left `pending` and **not** submitted; once the parent has an `etaUuid`, the next pass submits it with `referenceUuid` = the parent UUID.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/fiscal/worker.test.ts`. Expected: FAIL — module not found.

- [ ] **Step 3: Implement `drainEtaSubmissions`.** Create `src/server/fiscal/worker.ts`. Per claimed row, inside a `withTenant` tx:
  1. `resolveEtaConfig(tenantId)` → if `null` (config inactive), leave `pending`, skip (durable, no spray at ETA).
  2. Load the order/refund + its lines + resolve `product_tax_codes`.
  3. For `credit_note`: load the parent `e_receipt` submission; if it has no `etaUuid`, **defer** (skip without incrementing attempts).
  4. `buildReceipt`/`buildCreditNote` → on `MissingTaxCodeError`, set `status='failed'` + `lastError`, notify, continue.
  5. Attach the signature/hash → `hashOrSignature`; write `submissionUuid` + `status='submitted'` + `submittedAt` **before** the network call resolves (crash-safety).
  6. `provider.submit(doc, cfg)` → map result to `accepted` (persist `etaUuid`/`etaLongId`/`qrPayload`/`acceptedAt`) or `rejected` (persist `responseJson`/`lastError`).
  7. On a thrown transient error: `attempts++`, `status='failed'`, compute next backoff; if `attempts >= MAX_ATTEMPTS`, `notifyFiscalFailure`.
  8. `recordFiscalAudit(ctx, 'eta.submission.{submitted|accepted|rejected}', …, tx)` in the same tx.

Use `SELECT … FOR UPDATE SKIP LOCKED` on the claim query (raw `sql` — the same pattern the Spec 5 outbox worker and `pg_advisory_xact_lock` precedent establish).

- [ ] **Step 4: Run to verify they pass.** `npx vitest run src/server/fiscal/worker.test.ts && npx tsc --noEmit`. Expected: PASS, clean.

- [ ] **Step 5: Register the schedule.** Wire `drainEtaSubmissions` into the same scheduler that runs Spec 5's outbox worker (cron/scheduled route). If that scheduler does not exist yet, add a documented invocation point + a `// TODO: schedule alongside Spec 5 outbox worker` and note it in Self-Review — the function is complete and callable regardless.

- [ ] **Step 6: Commit.**

```bash
git add src/server/fiscal/worker.ts src/server/fiscal/worker.test.ts
git commit -m "feat(fiscal): drainEtaSubmissions worker — claim/build/sign/submit with retry, backoff, idempotency, audit + notify"
```

---

## Task 6: `fiscal:manage` permission + config service + read surfaces

`fiscal:manage` (**owner only**) gates the config dashboard + status reads; submission itself needs no permission (F8). The config API returns `activationStatus` + masked identifiers only — **never a secret**. The POS reads submission status per order for the receipt.

**Files:**
- Modify: `src/server/rbac/permissions.ts`
- Test: `src/server/rbac/permissions.test.ts`
- Create: `src/server/fiscal/config-service.ts`
- Create: `src/app/dashboard/fiscal-permission.ts`
- Create: `src/app/api/dashboard/fiscal/config/route.ts`
- Create: `src/app/api/pos/v1/sales/[orderId]/fiscal/route.ts`
- Create: `src/app/dashboard/fiscal/page.tsx`

**Interfaces:**
- Produces:
  - Permission `fiscal:manage` — held by `owner` **only** (not manager, not staff).
  - `function getFiscalConfig(tenantId): Promise<{ registrationNumber: string; clientId: string; environment; activationStatus; hasSecret: boolean; hasSigningKey: boolean } | null>` (masked).
  - `function updateFiscalConfig(tenantId, input): Promise<…>` (upsert; stores refs, never secrets).
  - `function getSaleFiscalStatus(tenantId, orderId): Promise<{ status; etaUuid: string | null; qrPayload: string | null; qrImageDataUrl: string | null } | null>` — generates the QR PNG data URL via the `qrcode` root dep when `accepted`.
  - `function requireFiscalPermission(): Promise<DashboardContext>`.

- [ ] **Step 1: Write the failing permission test.** Append to `src/server/rbac/permissions.test.ts`:

```ts
describe("fiscal:manage", () => {
  it("is held by owner only", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("fiscal:manage");
    expect(ROLE_PERMISSIONS.manager).not.toContain("fiscal:manage");
    expect(ROLE_PERMISSIONS.staff).not.toContain("fiscal:manage");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/server/rbac/permissions.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the permission.** In `src/server/rbac/permissions.ts`, add `"fiscal:manage"` to `PERMISSIONS` and append it to the `owner` array in `ROLE_PERMISSIONS` **only**.

- [ ] **Step 4: Write failing config-service tests.** Create `src/server/fiscal/config-service.test.ts`:
  - `updateFiscalConfig` then `getFiscalConfig` returns the registration/clientId/environment/activationStatus and `hasSecret: true`, and **never** returns `clientSecretRef`/`signingKeyRef` values (masking — the load-bearing secrets test).
  - `getSaleFiscalStatus` returns `null` while pending, and `{ status: "accepted", etaUuid, qrPayload, qrImageDataUrl }` (a `data:image/png;base64,…` string) once the row is accepted.
  - RLS: cross-tenant reads of all three tables return nothing.

- [ ] **Step 5: Run to verify they fail, then implement.** Create `src/server/fiscal/config-service.ts` (reads/writes via `withTenant`; QR via `import QRCode from "qrcode"` → `QRCode.toDataURL(qrPayload)`), and `src/app/dashboard/fiscal-permission.ts` (mirror `src/app/dashboard/audit-permission.ts`: `requireDashboardUser` + `authorize(ctx.roleKeys, "fiscal:manage")`).

- [ ] **Step 6: Implement the routes + page.** (First read `node_modules/next/dist/docs/` per `AGENTS.md`; follow existing `src/app/api/dashboard/**` + `src/app/api/pos/v1/**` conventions.)
  - `GET/PUT /api/dashboard/fiscal/config` — `requireFiscalPermission` → `getFiscalConfig` / `updateFiscalConfig`; 403 on `UnauthorizedError`.
  - `GET /api/pos/v1/sales/[orderId]/fiscal` — `requirePosCashier` + `assertPermission(ctx, "pos:sell")` → `getSaleFiscalStatus(ctx.tenantId, orderId)`; returns `{ status, etaUuid, qrPayload, qrImageDataUrl }` or `null`.
  - `src/app/dashboard/fiscal/page.tsx` — owner view: masked config form (registration, clientId, environment, activation status, "secret configured" indicator) + a submission-status table (docType, order/refund, status, etaUuid, attempts, lastError) so `failed`/`rejected` rows are visible for resubmission.

- [ ] **Step 7: Run tests + typecheck + lint.** `npx vitest run src/server/rbac/permissions.test.ts src/server/fiscal/config-service.test.ts && npx tsc --noEmit && npx eslint src/server/fiscal src/server/rbac src/app/api/dashboard/fiscal src/app/api/pos/v1/sales src/app/dashboard/fiscal`. Expected: PASS, clean.

- [ ] **Step 8: Commit.**

```bash
git add src/server/rbac/permissions.ts src/server/rbac/permissions.test.ts src/server/fiscal/config-service.ts src/server/fiscal/config-service.test.ts src/app/dashboard/fiscal-permission.ts src/app/api/dashboard/fiscal src/app/api/pos/v1/sales src/app/dashboard/fiscal
git commit -m "feat(fiscal): fiscal:manage (owner) + masked config API + POS fiscal-status endpoint + config dashboard"
```

---

## Task 7: `Receipt.tsx` renders the ETA UUID + QR

Once the fiscal block resolves to `accepted`, the receipt shows the ETA **QR** (from the server-generated `qrImageDataUrl`) and the **UUID**; while `pending`/`submitted` it shows "Fiscal receipt pending"; on `rejected` a non-blocking notice (the sale stands — the fix is a resubmit). A reprint renders the **stored** UUID/QR and never re-submits. For a refund, the accompanying credit-note references the original receipt's UUID (rendered on the refund slip once its `credit_note` is accepted).

**Files:**
- Modify: `apps/pos/src/screens/Receipt.tsx`
- Test: `apps/pos/src/screens/Receipt.test.tsx` (create if absent, following the POS renderer test convention)

**Interfaces:**
- Consumes: the Task 6 `GET /api/pos/v1/sales/:orderId/fiscal` payload.
- Produces: `ReceiptData` gains an optional `fiscal?: { status: "pending" | "submitted" | "accepted" | "rejected" | "failed"; etaUuid: string | null; qrImageDataUrl: string | null }` block. The screen polls the fiscal endpoint after the sale and re-renders when it resolves.

- [ ] **Step 1: Write the failing renderer tests.** In `apps/pos/src/screens/Receipt.test.tsx`, render `Receipt` with three fiscal states and assert:
  - `accepted` → the UUID text and an `<img>` with the `qrImageDataUrl` `src` are present.
  - `pending`/`submitted` → a "Fiscal receipt pending" line, no QR.
  - `rejected` → a non-blocking notice; the sale total/tenders still render unchanged.
  - No `fiscal` block (non-EG tenant) → the receipt renders **exactly as today** (no fiscal footer) — the country-gate no-behavioural-change guarantee.

- [ ] **Step 2: Run to verify they fail.** `cd apps/pos && npx vitest run src/screens/Receipt.test.tsx`. Expected: FAIL — `fiscal` not rendered.

- [ ] **Step 3: Implement.** Add the `fiscal?` field to `ReceiptData` and a fiscal footer below the "Thank you!" line:

```tsx
{data.fiscal && (
  <div className="mt-4 border-t border-dashed border-border pt-3 text-center">
    {data.fiscal.status === "accepted" && data.fiscal.qrImageDataUrl ? (
      <>
        <img src={data.fiscal.qrImageDataUrl} alt="ETA receipt QR" className="mx-auto h-28 w-28" />
        <p className="mt-1 text-[10px] text-muted-foreground break-all">ETA UUID: {data.fiscal.etaUuid}</p>
      </>
    ) : data.fiscal.status === "rejected" ? (
      <p className="text-[10px] text-muted-foreground">Fiscal receipt rejected — pending resubmission</p>
    ) : (
      <p className="text-[10px] text-muted-foreground">Fiscal receipt pending</p>
    )}
  </div>
)}
```

Wire the polling in the screen that owns the receipt (call the fiscal endpoint after `recordSale` returns; refresh on an interval until terminal). Keep the render **purely** driven by the `fiscal` prop so the component stays unit-testable.

- [ ] **Step 4: Run to verify they pass.** `cd apps/pos && npx vitest run src/screens/Receipt.test.tsx && npx tsc --noEmit`. Expected: PASS, clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/pos/src/screens/Receipt.tsx apps/pos/src/screens/Receipt.test.tsx
git commit -m "feat(pos): Receipt renders ETA UUID + QR once accepted, pending/rejected notices otherwise"
```

---

## Blocked — VERIFY with ETA

**2026-08-30 UPDATE — RESOLVED: see the addendum's VERIFY ledger (§5); items below preserved for traceability. Only item 7 (per-tenant obligation status) remains, as an operational check.** Original text follows. Do **not** invent ETA field names, endpoints, or encodings — build the surrounding machinery (Tasks 1–7) against the typed `FiscalDocument`/`FiscalSubmitResult` contract, keep the ETA-facing specifics behind `TODO(VERIFY)` markers, and only wire the real request/response body once each item below is confirmed against the current ETA developer portal / SDK. Each is load-bearing for legality.

- [ ] **BLOCKED — VERIFY 1: Submission window & synchronicity (highest risk).** Sources conflict between real-time/synchronous, an up-to-~24h acceptance window, and an earlier 72h claim. **Decision F4 (async, non-blocking — Tasks 4/5) depends on this.** Confirm the exact window, any "late submission" process, and whether **any** document type must be submitted **synchronously before the receipt is handed over**. If any document is synchronous, revisit the after-commit enqueue in Task 4 Step 4. Until confirmed, the async worker (Task 5) is the assumed model.
- [ ] **BLOCKED — VERIFY 2: Digital signature / e-seal for e-receipts (B2C).** The e-seal is clearly mandatory for **B2B e-invoices**; for **B2C e-receipts** sources disagree. Confirm whether e-receipts require the e-seal, whether a **cloud/HSM signing service** is required for automated volume, and the exact **signing algorithm + canonicalisation**. This drives `eta_tenant_config.signingKeyRef`, the worker's sign step (Task 5 Step 3.5), and `eta_submissions.hashOrSignature`. The field + code path are provisioned regardless; the algorithm stays `TODO(VERIFY)`.
- [ ] **BLOCKED — VERIFY 3: Credit-note mechanism for e-receipts specifically.** Credit/debit notes referencing the original UUID are documented for **e-invoices**; the **e-receipt** equivalent (document-type name, full cancellation vs. credit note, and the exact reference field to the original receipt) is **not** documented. Confirm how a refund is represented on the e-receipt system and the exact reference to the original receipt. This finalises `buildCreditNote`'s `referenceUuid` handling (Task 3) and the credit-note branch of the worker (Task 5).

**Also unconfirmed (carry forward from the spec; needed to finalise data, not the enqueue/worker skeleton):**
- [ ] VERIFY 4 — **Tax type/sub-type + unit-of-measure code lists** for `product_tax_codes` (`taxType`/`taxSubType`/`unitType`). EGS/GPC item coding is confirmed; the ETA tax/unit tables were not retrievable.
- [ ] VERIFY 5 — **QR payload format** (signed TLV vs. a verify URL built from `etaLongId`). Finalises `qrPayload` persistence (Task 5) and the QR render (Task 7).
- [ ] VERIFY 6 — **Authentication details:** token TTL, refresh cadence, per-device vs. per-system credential granularity, and preprod base URLs for `eta_tenant_config` + the submit client.
- [ ] VERIFY 7 — **Mandate applicability per tenant** (ETA obligated-taxpayer list + EGP 250,000 threshold). `activationStatus` gates submission until each tenant confirms inclusion.
- [ ] VERIFY 8 — **Resubmit / idempotency semantics** (re-query by `submissionUuid` vs. resubmit with an idempotency key) — the worker's crash-recovery guard (Task 5).

_No commit for this section — it is a gate, not a change. Do not remove a `TODO(VERIFY)` marker without linking the confirming ETA documentation in the commit that removes it._

---

## Task 8: Full-suite verification and manual acceptance

**Files:** none — this task changes nothing. It proves the spec.

- [ ] **Step 1: Run everything.** `npm test && npx tsc --noEmit && npx eslint src` and `cd apps/pos && npx vitest run && npx tsc --noEmit`. Expected: all PASS, all clean.

- [ ] **Step 2: Walk the spec's acceptance path** (on a tenant with `country="EG"` and an `active` `eta_tenant_config`, POS paired):
  - [ ] Classify a product in `product_tax_codes`; ring a sale of it → an `eta_submissions` row `docType='e_receipt'`, `status='pending'` appears; the **sale returns immediately** (no ETA wait).
  - [ ] Run the worker with a stubbed accepting provider → the row flips to `accepted` with `etaUuid` + `qrPayload`; `/api/pos/v1/sales/:orderId/fiscal` returns them; the receipt renders the QR + UUID.
  - [ ] Ring a sale of an **unclassified** product → the sale still completes; the worker marks the row `failed` with a product-naming `lastError` and the owner is notified. The sale is **not** blocked.
  - [ ] Issue a Spec 3 refund on the accepted receipt → a `credit_note` row referencing the parent `etaUuid` is enqueued and (after the worker) accepted.
  - [ ] Ring a sale on a **non-EG** tenant → **no** `eta_submissions` row, and the receipt renders with no fiscal footer.
  - [ ] Confirm `GET /api/dashboard/fiscal/config` **never** returns a secret; a `manager`/`staff` user gets **403**.

- [ ] **Step 3: Open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(fiscal): ETA e-invoicing & e-receipts behind a FiscalProvider (EG-gated, async, non-blocking)" --body "$(cat <<'EOF'
Implements docs/ailab/specs/2026-07-24-eta-einvoicing-and-ereceipts-design.md (Spec 11, decision D8).

- eta_submissions + product_tax_codes + eta_tenant_config (FORCE RLS); secrets are
  env/secret-manager REFERENCES, never stored in a row.
- FiscalProvider interface (shaped like BillingProvider) with NoopFiscalProvider and
  EtaFiscalProvider; resolveFiscalProvider gates on tenants.country === "EG".
- Pure buildReceipt/buildCreditNote mappers (no new money arithmetic); a sale commits
  and returns, then enqueues a pending e_receipt (non-blocking); drainEtaSubmissions
  submits asynchronously with retry/backoff, idempotency, audit (Spec 4) + notify (Spec 5).
- Refund → credit_note referencing the original UUID; Receipt.tsx renders UUID + QR
  once accepted. fiscal:manage (owner only) gates config; submission is a system action.

BLOCKED until confirmed against the ETA developer portal (see plan "Blocked — VERIFY
with ETA"): submission window/synchronicity, e-seal requirement for B2C e-receipts, and
the e-receipt credit-note mechanism. The wire format in EtaFiscalProvider.submit is
marked TODO(VERIFY) and must not ship to prod until these are resolved.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- *Data model* — `eta_submissions` (docType/order/refund refs, status, UUIDs, qrPayload, request/responseJson, attempts, lastError), `product_tax_codes` (egsCode/taxType/subType/unitType), `eta_tenant_config` (registration + credential refs + environment + activationStatus); FORCE RLS; partial unique indexes → **Task 1**.
- *Provider abstraction (F1/F2)* — `FiscalProvider` shaped like `BillingProvider`, `NoopFiscalProvider`, `resolveFiscalProvider` by country → **Task 2**.
- *Item coding + pure mapping (F6/F9)* — `buildReceipt`/`buildCreditNote` map lines via `product_tax_codes`, throw on a missing code, total straight from `money(n)` → **Task 3**.
- *Async, non-blocking pipeline (F4/F5)* — after-commit `enqueueFiscalDocument`, country gate, idempotent no-op re-enqueue, atomic refund-path enqueue → **Task 4**; `drainEtaSubmissions` claim/build/sign/submit with retry, backoff, idempotency, credit-note deferral → **Task 5**.
- *Authorization (F7/F8)* — `fiscal:manage` (owner only), masked config API, system-action submission, secret refs never echoed → **Task 6**.
- *Receipt UUID + QR* — accepted → QR + UUID; pending/rejected notices; non-EG renders unchanged → **Task 7**.
- *Audit (Spec 4) + notify (Spec 5)* — `eta.submission.{submitted|accepted|rejected}` + `critical` failure alert, via degrade-gracefully adapters → **Tasks 4/5**.
- *Compliance gates* — the three highest-risk unverified items (window/synchronicity, e-seal for B2C, e-receipt credit-note mechanism) plus the remaining five carried as explicit blocked steps → **`## Blocked — VERIFY with ETA`**.
- *Testing* — pure builder/parity, country gate, worker (accept/reject/retry/concurrency/missing-code/credit-note deferral), secrets masking, renderer, RLS → every task + **Task 8**.

**Deliberate deferrals (matching the spec's Non-goals):** the **B2B e-invoice trigger** (buyer tax-registration capture at the till) is schema/provider-ready (`docType='e_invoice'`) but not wired — consumer `e_receipt` is v1. The **credit-note enqueue** lives inside Spec 3's `issueRefund`; if Spec 3 is not yet on the branch when this lands, Task 4 Step 5 leaves a marked hook and the credit-note worker path is covered by fixtures until Spec 3 merges. **Scheduling** `drainEtaSubmissions` reuses Spec 5's outbox scheduler; if that scheduler is not present, the function is complete and callable and a `TODO` marks the wire-up.

**Dependency posture:** `recordAuditEvent` (Spec 4) and `notify` (Spec 5) are called through `src/server/fiscal/effects.ts`, which no-ops if the module is absent — so this PR stays green whether or not Specs 4/5 have merged, and upgrades to real audit/notify automatically once they do (mirroring Spec 3's graceful degradation against Spec 8).

**Type consistency:** `FiscalDocument` / `FiscalSubmitResult` / `EtaConfig` (Task 2) are the exact types `buildReceipt`/`buildCreditNote` and `EtaFiscalProvider.submit` produce/consume (Task 3), the worker persists (Task 5), and the config/read services surface (Task 6). `EnqueueInput`'s `docType` is the `eta_doc_type` enum from Task 1. The `ReceiptData.fiscal` block (Task 7) is exactly the `getSaleFiscalStatus` return shape (Task 6). Nothing crosses a task boundary as `any`, and the ETA-specific wire format is the **only** thing left `TODO(VERIFY)` — every ServeOS-side type is closed.
