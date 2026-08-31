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

  **(3b) as-built — the request/response shapes are no longer `TODO(VERIFY)`: every one was read off ETA's own SDK pages plus their published Postman collection, and each is cited at its use site.** (1) `eta-env.ts` holds the one preprod/prod map (identity / API / portal bases, verbatim from the FAQ's URL table) plus the preprod TLS seam — `NODE_EXTRA_CA_CERTS`, because `undici` is not importable here so `fetch` cannot be handed a per-request CA; disabling verification is documented as forbidden. (2) Token client: POS login sends the four documented headers (`posserial`/`pososversion`/`posmodelframework`/`presharedkey`) with `grant_type`/`client_id`/`client_secret` form-encoded and no scope; the ERP login uses RFC 2617 Basic with `grant_type`+`scope`. Tokens are cached per `environment|clientId|posSerial` in process memory only, with a 60s renewal margin, and a 401 forces exactly one re-login. (3) `submit` posts `{"receipts":[<doc>]}` via `stringifyWire` (never `JSON.stringify`, which would destroy the decimal literals the uuid was hashed over); **`signatures` is deliberately omitted** — the page requires an issuer signature but also says validation "will not be deployed at this point", and every ETA Postman sample omits it, so the element is a seam rather than a fabricated value. (This IS VERIFY 2's answer, not an open question: the ledger records it **RESOLVED** — C7, ETA does not enforce receipt signatures today — and the seam exists for the day that changes.) A 202 maps to `"submitted"` (it is "accepted for further processing", not a verdict) carrying `submissionUUID`/`longId`; a document in `rejectedDocuments` maps to the terminal `"rejected"`. (4) `poll` maps `InProgress`→`submitted`, `Valid`→`accepted`, `Invalid`→`rejected`, `Cancelled`→`accepted`, and refuses to guess at any undocumented status. (5) New `eta-transport-errors.ts`: `EtaTransportError` (RETRYABLE — carries status, `Retry-After` seconds, ETA error code, correlation id, redacted body) and `EtaConfigError` (PERMANENT config fault), both deliberately outside the `FiscalDocumentError` family. A device missing its pre-shared key fails fast as `EtaConfigError` instead of sending an incomplete login.

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

- [x] **Step 0 (added 2026-08-31, review finding): reconciliation sweep** — the worker pass must also detect EG orders older than a threshold with NO eta_submissions row (a thrown sale-path enqueue leaves no row, so no row-based monitoring can see it) and enqueue them, closing the only gap where "never block the sale" trades away the compliance guarantee.

- [x] **Step 1 (as-built: implementation-then-tests — see bullet 8): Write the failing tests.** Create `src/server/fiscal/worker.test.ts`, injecting a stubbed provider (accept / reject / throw variants):
  - **Accept:** a `pending e_receipt` → the worker records `etaUuid`/`qrPayload`, sets `status='accepted'` + `acceptedAt`, and emits the `eta.submission.accepted` audit event.
  - **Reject:** the provider returns `rejected` → `status='rejected'`, `responseJson` captured, `lastError` set, owner notified, and `eta.submission.rejected` emitted. The sale stands.
  - **Transient error:** the provider throws → `attempts++`, `status='failed'`, backoff set; after `MAX_ATTEMPTS` the row stays `failed` and a Spec 5 `critical` `notify` fires **once**.
  - **Missing tax code:** a line with no `product_tax_codes` row → `MissingTaxCodeError` → `status='failed'` with a product-naming `lastError`; the **sale is untouched** (assert the order + tenders are unchanged).
  - **Concurrency:** two `drainEtaSubmissions` runs over the same row submit it **exactly once** (`SKIP LOCKED`).
  - **Credit-note deferral:** a `credit_note` whose parent receipt is not yet `accepted` is left `pending` and **not** submitted; once the parent has an `etaUuid`, the next pass submits it with `referenceUuid` = the parent UUID.

- [x] **Step 2 (as-built: implementation-then-tests — see bullet 8): Run to verify they fail.** `npx vitest run src/server/fiscal/worker.test.ts`. Expected: FAIL — module not found.

- [x] **Step 3: Implement `drainEtaSubmissions`.** Create `src/server/fiscal/worker.ts`. Per claimed row, inside a `withTenant` tx:
  1. `resolveEtaConfig(tenantId)` → if `null` (config inactive), leave `pending`, skip (durable, no spray at ETA).
  2. Load the order/refund + its lines + resolve `product_tax_codes`.
  3. For `credit_note`: load the parent `e_receipt` submission; if it has no `etaUuid`, **defer** (skip without incrementing attempts).
  4. `buildReceipt`/`buildCreditNote` → on `MissingTaxCodeError`, set `status='failed'` + `lastError`, notify, continue.
  5. Attach the signature/hash → `hashOrSignature`; write `submissionUuid` + `status='submitted'` + `submittedAt` **before** the network call resolves (crash-safety).
  6. `provider.submit(doc, cfg)` → map result to `accepted` (persist `etaUuid`/`etaLongId`/`qrPayload`/`acceptedAt`) or `rejected` (persist `responseJson`/`lastError`).
  7. On a thrown transient error: `attempts++`, `status='failed'`, compute next backoff; if `attempts >= MAX_ATTEMPTS`, `notifyFiscalFailure`.
  8. `recordFiscalAudit(ctx, 'eta.submission.{submitted|accepted|rejected}', …, tx)` in the same tx.

Use `SELECT … FOR UPDATE SKIP LOCKED` on the claim query (raw `sql` — the same pattern the Spec 5 outbox worker and `pg_advisory_xact_lock` precedent establish).

- [x] **Step 4: Run to verify they pass.** `npx vitest run src/server/fiscal/worker.test.ts && npx tsc --noEmit`. Expected: PASS, clean.

- [x] **Step 5: Register the schedule.** Wire `drainEtaSubmissions` into the same scheduler that runs Spec 5's outbox worker (cron/scheduled route). If that scheduler does not exist yet, add a documented invocation point + a `// TODO: schedule alongside Spec 5 outbox worker` and note it in Self-Review — the function is complete and callable regardless.

- [x] **Step 6: Commit.**

```bash
git add src/server/fiscal/worker.ts src/server/fiscal/worker.test.ts
git commit -m "feat(fiscal): drainEtaSubmissions worker — claim/build/sign/submit with retry, backoff, idempotency, audit + notify"
```

  **as-built (2026-08-31):**

  - **Files, vs the plan's two.** `src/server/fiscal/worker.ts` (+ `worker.test.ts`) as specified, plus three the plan did not anticipate:
    - `src/server/fiscal/finalize.ts` — steps 1-2 (build + hash + chain advance) split out of the worker, because `recordSale` now calls them too and the sale path must not import the ETA HTTP client. Holds `finalizeSubmissionRow`, `enqueueAndFinalizeReceipt` and `reconcileMissingReceipts`.
    - `src/server/fiscal/parse-wire.ts` (+ test) — the inverse of `stringifyWire`; see the `request_json` note below.
    - `src/server/fiscal/enqueue.ts` gains `enqueueCorrectedResubmission` (addendum C3), beside the arbiter constants it shares. Not wired to any trigger: Task 6's dashboard owns that, and it is allowlisted in `audit/coverage.ts` because it has no actor in scope — **Task 6 must emit the who-asked-for-it audit event at the route.**
  - **Finalization happens at ENQUEUE time, not only in the worker** (addendum C5 — the printed customer copy must carry the QR + uuid at issuance). Finalization is pure-local (chain read, serialize, SHA-256), so `recordSale`'s existing after-commit try/catch now calls `enqueueAndFinalizeReceipt`; the worker finalizes any row still lacking an `etaUuid` as its first per-row step, which is the authoritative fallback. Lock order inside that one transaction is **tenant, then device** (`pg_advisory_xact_lock`), documented at the call site so `recordAuditEvent`'s own tenant lock later in a transaction can never invert it.
  - **Two migrations, not one.** `0049` adds `eta_tenant_config.online_device_id` (FK `pos_devices`, ON DELETE restrict) and `wire_context_json` (the receipt v1.2 seller fields ServeOS stores nowhere else). `0050` changes `eta_submissions.request_json` from **jsonb to json** — a correctness fix found while testing: jsonb normalizes property order (verified against this deployment), and ETA's serialization hashes properties *in document order*, so a document round-tripped through a jsonb column can never be re-serialized into the bytes it was hashed from. `json` stores the text verbatim. The column is written with `sql`${stringifyWire(wire)}::json`` and read back via `request_json::text` + `parseWire`, which is why that module exists.
  - **Failure taxonomy** implemented exactly as `provider.ts` specifies, with one coordinator decision on top: `BadStructure`, `MaximumSizeExceeded` and `IncorrectSubmitter` arrive as `EtaTransportError` but are treated as PERMANENT (the identical payload fails identically), per the AMBIGUITY note that error class already carries. `MAX_ATTEMPTS = 6`; the terminal alert fires exactly once because a permanent failure parks `attempts` at the cap and the claim query excludes it.
  - **Claim** is the outbox worker's shape — `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` — but leases via `nextAttemptAt` rather than a status flip: `eta_submissions.status` is the FISCAL lifecycle, and adding a transport state to it would make the fiscal record lie. `submitted` rows are claimed too, for the poll phase; a poll that comes back `InProgress` costs no attempt.
  - **Scheduling** initially rode the existing `/api/notifications/worker` cron with a `TODO(schedule)`, because its inherited `0 3 * * *` slot is far too slow for a 24-hour submission window. **Superseded in Task 6**, which gave the drain its own `/api/fiscal/worker` route on a `*/15` entry and removed it from the notifications cron — see that task's as-built for the deploy-tier gate.
  - **Resubmission guard** (plan Step 5's intent): the submit-vs-poll branch keys on `submissionUuid`, NOT on `status = 'submitted'`. A poll that dies in transit leaves the row `failed` while still holding a submissionUuid, and branching on status would have re-POSTed a document ETA already holds — outside its ~10-minute duplicate window that files a second copy of the receipt. Pinned by a regression test.
  - **Order of work** was implementation-then-tests, not the plan's strict red-first (Steps 1-2). The tests did their job regardless: the first run failed 5 of 19 and is what surfaced the jsonb ordering bug above.
  - One unrelated test was adjusted: `pos/offline-lifecycle.test.ts`'s concurrent-ingest case asserted that the losing run reports all 8 events as duplicates, which assumed both runs advance at the same rate. EG sale events now cost visibly more (inline finalization), so the two interleave; the assertion is now per-event (exactly one `applied` and one `duplicate` across the two runs), which is stronger and scheduling-independent.
  - Actual commit message: `feat(fiscal): finalize-at-enqueue + drainEtaSubmissions worker (chain, poll, reconciliation, resubmission)` — no trailers, per house convention.

  **post-review follow-up (2026-08-31), commit 3:**

  - **Guardrail scan coverage.** `finalize.ts` and `worker.ts` joined `AUDITED_SERVICE_FILES`; `recordFiscalAudit` joined the test's `EMIT_RE` (it is a real emitter — a named wrapper over `recordAuditEvent`); `finalize.finalizeSubmissionRow` is allowlisted (it prepares a document, and the lifecycle it feeds is audited on the same row); the now-paid `forward:eta.*` entry was retired. The worker's three status writers had been calling a local `audit()` wrapper, which no scan could ever recognise — they now call `recordFiscalAudit` inline, so the emission is visible where the write is.
    **Honest limit, worth a decision later:** the scanner enumerates EXPORTED functions only, and the worker's writers are private helpers, so `worker.ts` contributes zero symbols today — it is forward coverage (a future exported writer gets caught), not present coverage. Widening `enumerateMutatingSymbols` to private top-level functions was measured: **14 new gaps repo-wide, 8 of them outside fiscal** (inventory ×6, recipes, tenancy/settings). That is a shared-guardrail semantic change and other domains' justifications to write, so it was not taken here.
  - **HTTP timeout + lease coupling.** `ETA_HTTP_TIMEOUT_MS = 60_000` now bounds every provider call via `AbortSignal.timeout`, aborting into a **retryable** `EtaTransportError` (an abandoned request says nothing about whether the document was judged). `CLAIM_LEASE_MS` documents the arithmetic it is half of: `lease (5 min) + fetch timeout (60s) < ETA's ~10-minute DuplicateSubmission window`. A lease that expires mid-submit lets a second drain re-POST, which is safe ONLY while ETA still answers 422 `DuplicateSubmission`; raising either constant past that window files a second legal document for one sale.
  - **Sweep count** now counts rows that actually landed, not orders considered — a count including its own failures would read the same whether the sweep worked or not, which is the blindness it exists to close.

  **quality-review follow-up (2026-08-31), commit 4:**

  - **CONTRACT CHANGE — `EtaConfig.signingKey` is now `() => string | null`**, matching `erp.clientSecret`. Both are B2B-only credentials that no receipt path reads, and resolving the e-seal eagerly meant one stale `signing_key_ref` threw out of `resolveEtaConfig` — which the worker classifies as PERMANENT, so it would have terminally failed every receipt the tenant ever issued over a credential none of them use. `null` (no signing material) stays a value; a set-but-unresolvable ref throws only when called, naming the column and env key. Any Task 6/7 code building an `EtaConfig` by hand must pass a thunk. Only the DEVICE secrets still resolve eagerly, which is correct — they are the ones receipts actually submit with.
  - **Dual-drain pin** (the plan's own required concurrency test): two `drainEtaSubmissions` in `Promise.all` over one pending row assert exactly one `submit`. Mutation-checked — it fails (2 submits) when the claim's `FOR UPDATE SKIP LOCKED` is removed.
  - **Tenant gate hoisted above the claim and the sweep.** An unconfigured tenant now costs one config query per pass instead of a claim plus a lease bump on every row it owns, and `DrainResult.skippedTenants` reports the onboarding backlog. Nothing is lost by waiting: the sweep has no upper age bound, so an activating tenant adopts every order it skipped.
  - **Notify-once under a race.** Both terminal writers now decide who alerts by whether their UPDATE matched a row: `failPermanently` predicates on `attempts < MAX_ATTEMPTS`, `failTransiently` compare-and-sets on the attempt count read at claim time (which also makes the counter itself race-safe, so "failed 6 times" means six real attempts). Both mutation-checked: removing either predicate produces the second alert.
  - **Sweep bounds pinned**: a backlog larger than `limit` yields exactly `limit` per pass, oldest first; an order at `threshold - ε` is left alone while `threshold + ε` is swept.
  - **Guardrail honesty**: the list head now states that listing a file buys forward coverage only where its writers are private helpers, names the three worker-shaped modules in that position (`notifications/worker.ts`, `whatsapp/status-worker.ts`, `fiscal/worker.ts`), and points at the deferred widening measured above.

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

- [x] **Step 1: Write the failing permission test.** Append to `src/server/rbac/permissions.test.ts`:

```ts
describe("fiscal:manage", () => {
  it("is held by owner only", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("fiscal:manage");
    expect(ROLE_PERMISSIONS.manager).not.toContain("fiscal:manage");
    expect(ROLE_PERMISSIONS.staff).not.toContain("fiscal:manage");
  });
});
```

- [x] **Step 2: Run to verify it fails.** `npx vitest run src/server/rbac/permissions.test.ts`. Expected: FAIL.

  **as-built (2026-08-31):** red confirmed — 2 failed / 14 passed before the implementation, then 16 passed after.

- [x] **Step 3: Implement the permission.** In `src/server/rbac/permissions.ts`, add `"fiscal:manage"` to `PERMISSIONS` and append it to the `owner` array in `ROLE_PERMISSIONS` **only**.

  **as-built (2026-08-31):** the test also pins `pharmacist` and `super_admin` as non-holders — the plan's sketch named only manager/staff, and a permission this narrow is worth asserting against every role rather than the two that happened to come to mind.

- [x] **Step 4: Write failing config-service tests.** Create `src/server/fiscal/config-service.test.ts`:
  - `updateFiscalConfig` then `getFiscalConfig` returns the registration/clientId/environment/activationStatus and `hasSecret: true`, and **never** returns `clientSecretRef`/`signingKeyRef` values (masking — the load-bearing secrets test).
  - `getSaleFiscalStatus` returns `null` while pending, and `{ status: "accepted", etaUuid, qrPayload, qrImageDataUrl }` (a `data:image/png;base64,…` string) once the row is accepted.
  - RLS: cross-tenant reads of all three tables return nothing.

  **as-built (2026-08-31):** 23 tests, all three of the plan's cases plus the ones a security-sensitive surface needs. **The masking test is value-based, not shape-based:** every `*Ref` column holds a distinctive sentinel, and `expectNoRefValues` walks every string in a return value (or an audit row) looking for one as a SUBSTRING. A `toEqual` on a hand-written shape would let a field added later slip past, and the guarantee is about values, not keys. It is **mutation-checked**: adding `secretRef: row.clientSecretRef` to the config view makes it fail with `updateFiscalConfig leaked env://…`. Also covered: the audit trail (audit rows are readable by every `audit:view` holder — owner AND manager — a strictly wider audience than `fiscal:manage`), the thrown `FiscalConfigInputError`, and a closing end-to-end case that asks `resolveEtaConfig` for the real credentials, proving the refs were stored verbatim and the masking is a read-side guarantee rather than a lossy write.

  **Walk coverage was a gap, found in spec review and closed (2026-08-31, follow-up commit).** The walk originally covered only the config and credential views — the obvious leak sites — leaving `listSubmissions`, `getSaleFiscalStatus`, `getSubmissionById` and `listFiscalDevices` unasserted, even though `lastError` is worker-written free text and device labels are operator-typed. All four are now walked, and the walk is proven LIVE on each of their four distinct shapes (nested array, `{rows, hasMore}` wrapper, flat record, plain list) by planting a reference where an accidental leak would actually land and asserting the walk throws.

  **Deliberate scope, recorded in the test so nobody "tightens" it by accident:** an env KEY NAME reaching `lastError` is permitted. `resolveSecretRef` states the stance outright — "The thrown message names the ENV KEY, which is not itself a secret, and never the value" — because an operator staring at a failed receipt needs to know which variable is unset. The fixture seeds a submission carrying that exact `EtaConfigError` message and asserts the walk passes it. So the pinned invariant is narrower and sharper than "no reference string ever appears": **no reference VALUE and no resolved SECRET transits.** The distinction is only legible because the test stores refs in the `env://KEY` spelling; `resolveSecretRef` also accepts a BARE key, and a deployment using that spelling would make the stored column value and the error's key name the same characters — which is exactly why config.ts's stance has to be a considered decision rather than an accident of format.

  Beyond the plan's list: RIN/serial/threshold accept-reject tables; every mandatory wire-context path (the exact set `requireWireContext` enforces); cross-tenant and nonexistent `onlineDeviceId`; the credential status-transition table; blank-ref-means-keep vs. explicit-null-means-clear; `getSaleFiscalStatus` walking null → pending-unfinalized → pending-finalized → accepted through a **real** `recordSale` (so the QR comes from `./finalize`'s stored payload, not a fixture) plus the correction-supersedes-rejection case; and `listSubmissions` ordering, pagination and the page cap.

- [x] **Step 5: Run to verify they fail, then implement.** Create `src/server/fiscal/config-service.ts` (reads/writes via `withTenant`; QR via `import QRCode from "qrcode"` → `QRCode.toDataURL(qrPayload)`), and `src/app/dashboard/fiscal-permission.ts` (mirror `src/app/dashboard/audit-permission.ts`: `requireDashboardUser` + `authorize(ctx.roleKeys, "fiscal:manage")`).

  **as-built (2026-08-31):** the service is wider than the plan's four functions, because the dashboard and the POS both need more than the plan sketched: `getFiscalConfig` / `updateFiscalConfig` / `listDeviceCredentials` / `getDeviceCredential` / `upsertDeviceCredential` / `listFiscalDevices`, plus one input-error class.

  **SPLIT IN TWO after quality review (finding 1, 2026-08-31):** the read surfaces — `getSaleFiscalStatus`, `listSubmissions`, `getSubmissionById`, and the new `getSubmissionStatusCounts` — moved to **`src/server/fiscal/read-model.ts`**, and `qrcode` moved with them. The seam is the PERMISSION, not file size: everything left in `config-service.ts` is `fiscal:manage` (owner) and most of it writes a compliance record, while `getSaleFiscalStatus` is reached by any cashier holding `pos:sell`. Having the till import a module whose other exports mutate the taxpayer's identity was the wrong shape, and it pulled a PNG renderer into every config import. `config-service.ts` drops 907 → 728 lines; three import sites moved (the POS fiscal route, the dashboard page, and `dashboard/fiscal/resubmit.ts` — the third was not in the review's list).

  **The masking walk deliberately did NOT split.** It stays in `config-service.test.ts` covering both modules, and both module headers say so: the no-reference rule is one guarantee over one fiscal API, and splitting the assertion across two files makes it two half-guarantees that drift. `read-model.ts` also restates the rule in full rather than cross-referencing it, so it survives someone reading only that file.

  - **`zod` is now a declared runtime dependency** (`package.json` + lockfile). It was already in `node_modules` as a *dev-only transitive* of `eslint-plugin-react-hooks`, and importing an eslint plugin's transitive dep from `src/server` would be a live production hazard. Nothing else in the repo uses zod (the house convention is hand-rolled validators), so this is a **deliberate, reviewable dependency addition**: the wire context is a nested block of 20+ fields whose per-field paths drive the form's error messages, which is exactly what hand-rolling gets wrong. `zod` never leaves the service — `ZodError` is converted to one `FiscalConfigInputError` carrying `{ path, message }[]`, so no route imports it.

    **Two disclosures a PR reviewer should not have to dig for** (both also recorded at the import site and in addendum §6): (1) the change is **not a pure dev→prod hoist — it BUMPED zod 4.4.3 → 4.5.4**, because `npm install` resolved the new `^4.5.4` caret past the transitive 4.4.3 that was on disk; the lockfile diff carries a version change as well as a flag change. (2) **One type-level edge crosses a module boundary**: `UpdateFiscalConfigInput` / `UpsertDeviceCredentialInput` are `z.input<typeof …>` and the dashboard routes import them to shape request bodies. The types erase at compile time — nothing zod-shaped reaches the bundle or the wire — but a zod MAJOR bump that changes inference would break `tsc` in `api/dashboard/fiscal/**` rather than in the service, which is a confusing place to discover it.
  - **`getFiscalConfig` also returns `wireContext` itself**, which the plan's masked shape did not list. It holds no credential of any kind (trade name, activity code, branch address — all printed on every receipt), and without it the config form could not show what is stored, so every save would mean retyping eleven fields to change one. The deep masking assertion covers it.
  - **Write-only refs are optional on update.** The form cannot display a reference, so requiring one on every save means retyping a credential pointer to change the environment dropdown — and a mistyped pointer breaks submission silently. Blank means "keep"; a required-on-create check catches the first save. `signingKeyRef` distinguishes `undefined` (keep) from `null` (clear), because "no e-seal" is the ordinary state of a receipt-only tenant and blank-means-keep would otherwise make it unreachable.
  - **`upsertDeviceCredential` enforces a documented status transition table** (`registered → active`, `active → expired`, `expired → active`, `* → retired`, and `retired` terminal). `retired` is terminal because `eta_device_chains` keys the uuid chain on the device: reviving a retired credential is how a till comes back with a chain someone believes is finished. `activatedAt` is stamped by the service on the transition into `active`, never accepted from the caller.
  - **`getSaleFiscalStatus` takes the NEWEST row** when a sale has several. The live partial indexes cap non-rejected rows at one per (tenant, docType, order), so the only way to have more is a rejection superseded by a correction — and the correction is the document that counts. The QR is rendered from the STORED `qrPayload` only; recomputing it could print a code that disagrees with the hashed document.
  - `fiscal-permission.ts` exports **both** `requireFiscalPermission` (the plan's audit-permission mirror, used by the page) and `resolveFiscalContext` (the `purchasing-permission.ts` ladder, used by the routes). Without the second, an API caller with no session gets a 307 to the HTML login form, which a `fetch` cannot act on.

- [x] **Step 6: Implement the routes + page.** (First read `node_modules/next/dist/docs/` per `AGENTS.md`; follow existing `src/app/api/dashboard/**` + `src/app/api/pos/v1/**` conventions.)
  - `GET/PUT /api/dashboard/fiscal/config` — `requireFiscalPermission` → `getFiscalConfig` / `updateFiscalConfig`; 403 on `UnauthorizedError`.
  - `GET /api/pos/v1/sales/[orderId]/fiscal` — `requirePosCashier` + `assertPermission(ctx, "pos:sell")` → `getSaleFiscalStatus(ctx.tenantId, orderId)`; returns `{ status, etaUuid, qrPayload, qrImageDataUrl }` or `null`.
  - `src/app/dashboard/fiscal/page.tsx` — owner view: masked config form (registration, clientId, environment, activation status, "secret configured" indicator) + a submission-status table (docType, order/refund, status, etaUuid, attempts, lastError) so `failed`/`rejected` rows are visible for resubmission.

  **as-built (2026-08-31).** Next 16.2.9; the bundled docs (`01-app/03-api-reference/03-file-conventions/route.md`, `dynamic-routes.md`, `01-getting-started/15-route-handlers.md`) were read first and shaped two decisions:

  - **The POS route is `sales/[id]/fiscal`, NOT `sales/[orderId]/fiscal`.** Next refuses two different slug names at the same dynamic position — `build/validate-app-paths.js` still carries "You cannot use different slug names for the same dynamic path" in this version — and the existing siblings (`sales/[id]/{payments,refund,reprint}`) already claim `[id]`. `npx next typegen` confirms all new paths register, `/api/pos/v1/sales/[id]/fiscal` included.
  - `params` is a **Promise** in this version and is awaited (`{ params }: { params: Promise<{ id: string }> }`), matching both the docs and the sibling routes. The `RouteContext<'/users/[id]'>` helper exists but the house style is the explicit type, so that is what is used.
  - **Absent-yet is a `null` body with a 200, not a 404.** A 404 would make the POS treat a non-EG tenant's ordinary receipt as an error; `null` is what the country gate's no-behavioural-change guarantee needs.

  Routes beyond the plan's two, because the dashboard needs them: `GET /api/dashboard/fiscal/devices` (devices + masked credentials in one response), `GET/PUT /api/dashboard/fiscal/devices/[deviceId]`, and `POST /api/dashboard/fiscal/submissions/[id]/resubmit`.

  **The resubmission audit event — Task 5's allowlist debt, paid.** `enqueueCorrectedResubmission` is allowlisted in `audit/coverage.ts` precisely because it has no actor in scope and "the who-asked-for-it event belongs to Task 6's dashboard route". It now lives in **`src/app/dashboard/fiscal/resubmit.ts`**, shared by the route AND the page's server action, rather than inline in the route as the brief sketched: the dashboard reaches the same act from two directions, and duplicating the emission across two callers is how one of them silently loses it. Insert first, then audit — the enqueue opens its own transaction, so the two cannot be atomic, and an unattributed correction (whose lifecycle the worker still audits) beats an audit row claiming a correction that was never queued.

  **One leak the review found and closed: the log line.** Every other route in the codebase logs its unexpected failures as `{ …, error: e }`, and is right to — but a Drizzle failure puts the failing query's PARAMETERS in `error.message` (`params: <tenant>,<rin>,<client_secret_ref>,…`), so the house line would have written the credential references into the deployment's log stream on any constraint or connectivity error. Both fiscal write routes log `redactedCause(e)` instead — error class name, plus a Postgres error's SQLSTATE and violated constraint, none of which can carry a value — pinned by a test that feeds it a real Drizzle-shaped error and asserts the refs are gone.

  Also landed here, out of the plan's Task 5 Step 5 debt: **`/api/fiscal/worker` on its own `*/15` cron entry** in `vercel.json`, with the `drainEtaSubmissions` call and its `TODO(schedule)` **removed** from `/api/notifications/worker` so the drain has exactly one owner. The route carries a **deploy-review gate**: Vercel Hobby crons are daily-only, so a 15-minute schedule needs Pro or above, and no EG tenant should go live until the tier is confirmed — `CLAIM_LEASE_MS` and the fetch timeout in `worker.ts` are sized for sub-hourly.

  The page ships a nav entry gated on **`country === "EG"` AND `fiscal:manage`** (`dashboardNavItems` gained an optional `country`). Defaulting to hidden keeps the existing exact-array owner-nav assertion honest; an owner outside Egypt would otherwise be shown a setup screen that can never submit anything.

  **Page split (quality review, finding 4):** the two tables moved to `src/components/dashboard/FiscalCredentialsTable.tsx` and `FiscalSubmissionsTable.tsx`, dropping `page.tsx` from 412 → 318 lines. Both are props-driven and import nothing from the server at runtime — the two `import type`s are erased at compile time — and the submissions table takes its server action as a PROP, so the component owns where the button goes and the page owns what it does.

  **Status counts (finding 3):** `getSubmissionStatusCounts` (one `GROUP BY` over the whole table) now renders as a chip row above the feed. The paginated list could never answer the question it answers — 25 rows of "newest first" say nothing about last Tuesday's four rejections, which are exactly what an owner opens this screen to find. Every status is present and zero-filled in enum order: a chip row built from a sparse map would appear and disappear as documents moved between states, and "rejected 0" is a materially different thing to be told than nothing at all.

  **Product tax-code write surface (final review, I3 — the day-one blocker):** `product_tax_codes` shipped with readers and no writer, so an EG tenant could not complete acceptance-walk step 1 except by SQL. Added `listProductTaxCodes` (LEFT JOIN **from** products, so the unclassified ones — the rows an operator is there to clear — are what the screen leads with) and `upsertProductTaxCode` (Zod, an `assertOwnProduct` tenant predicate so a foreign product id is a 400 naming the field rather than an opaque FK 500, and an `eta.product_tax_code.updated` audit event carrying field names in the house style). Route shape follows `devices`: `GET /tax-codes` for the collection, `GET`/`PUT /tax-codes/[productId]` for one row — the product IS the key (`product_tax_codes_product` is unique on tenant + product), so `PUT` is an upsert and the id comes from the PATH, never the body.

  **Env:// save-side references (final review, M6):** `refSchema` now requires the `env://` scheme on every ref field of both write surfaces. `resolveSecretRef` still accepts a bare key so legacy rows keep resolving — pinned by a test that seeds one past the service and resolves it — but a bare key can no longer be SAVED, because stored bare the reference VALUE and the env KEY NAME are the same characters, and that collapse is exactly what the masking walk's central distinction depends on staying apart.

  **Constant move (round-1 flag):** `SUBMISSION_WINDOW_MS` moved from `worker.ts` to a new **`src/server/fiscal/constants.ts`** — chosen over folding it into `read-model.ts`, which would have inverted a worse dependency (the submission worker importing the dashboard's read layer). `read-model.ts` importing `worker.ts` for one number was dragging the ETA HTTP client, the provider and the transport-error taxonomy into the import graph of every dashboard page and POS route that reads a submission. The arithmetic JSDoc moved with the constant; `worker.ts` keeps a breadcrumb where it used to sit.

  **Resubmit route consistency (finding 5):** it now carries the same `try`/`catch` + `redactedCause` log as the sibling write routes. Nothing on that path touches a `*_ref` column, so a raw log would leak nothing today — the comment says so — but a uniform shape has no exception for someone to forget when they copy one of these handlers to a route that *does* carry references.

- [x] **Step 7: Run tests + typecheck + lint.** `npx vitest run src/server/rbac/permissions.test.ts src/server/fiscal/config-service.test.ts && npx tsc --noEmit && npx eslint src/server/fiscal src/server/rbac src/app/api/dashboard/fiscal src/app/api/pos/v1/sales src/app/dashboard/fiscal`. Expected: PASS, clean.

  **as-built (2026-08-31):** ran wider than the plan's scope, since this task touches rbac, audit coverage and the shared nav.

  **Counts, re-measured after each review round rather than estimated.** This task touches **6 test files** — `config-service.test.ts` (new, 30), `fiscal-routes.test.ts` (new, 13), `api/pos/v1/sales/[id]/fiscal/route.test.ts` (new, 5), `api/fiscal/worker/route.test.ts` (new, 3), `permissions.test.ts` (14 → 16, +2) and `nav-items.test.ts` (8 → 9, +1) — for **54 new tests**. Scope run (`src/server/{fiscal,audit,rbac}` + `src/app` + `src/components`): **46 files / 539 tests passed**. Full `npm test`: **190 files / 1556 tests passed**. Two earlier drafts of this note said 1532 and then 1534; each predated tests that landed in the following review round. `npx tsc --noEmit` clean. `npx eslint src/server/fiscal src/server/rbac src/app src/components/dashboard` reports only 6 **pre-existing** `no-html-link-for-pages` errors in `admin/`, `login/` and `register/` pages, none of them touched here; nothing new. `npx next build` succeeds with all new paths registered as dynamic server functions (seven at this task's close; nine after the final-review rounds added the tax-code routes), which is the check that would have caught a route conflict.

  **Route tests exist** — there is a house pattern (`src/app/api/purchase-orders/**/route.test.ts`), and it is followed: mock the ONE seam that needs a live HTTP request and leave everything below it real, so the permission check, the services, RLS and the audit chain are exercised rather than stubbed into agreement. On the dashboard routes that seam is `requireDashboardUser`, NOT `resolveFiscalContext` — the point is that the real `authorize(roleKeys, "fiscal:manage")` runs and a manager is genuinely refused. On the POS route it is `requirePosCashier`, pulled in through `importOriginal` so the REAL `assertPermission` still decides the 403.

  Covered: masked GET/PUT over the serialized response; 403 for manager/staff/pharmacist with nothing written; 400-with-field-path for a bad RIN and for malformed JSON; the devices list and per-device GET/PUT (403 on all three handlers, 404 for a till with no credential, masked round-trip, 400 ladder — whose full field-by-field coverage is in the service test, noted in a comment there); the resubmit route's 201 + audit row + 403 + 404 + all three 409 preconditions; and the cron gate.

  **The POS route test pins the exact ladder Task 7 codes against** (quality review, finding 2), so the client can be written from that file rather than from a reading of the handler: 401 for a bad device token and for a signed-out cashier, 403 without `pos:sell`, **a literal `null` body with 200** when the order has no submission (asserted on the raw response text as well as the parsed value — `null` and an empty body are indistinguishable after `.json()` in some clients), the happy path returning `status` + `etaUuid` + a `data:image/png` QR for a sale rung through the real `recordSale`, and tenant scoping. That happy path also pins the thing Task 7 is most likely to get wrong: the row is finalized inline at sale time, so **status is still `pending` while the QR already exists** — gating the QR render on `accepted` would hide the code the post-clearance model wants on the customer copy.

- [x] **Step 8: Commit.**

```bash
git add src/server/rbac/permissions.ts src/server/rbac/permissions.test.ts src/server/fiscal/config-service.ts src/server/fiscal/config-service.test.ts src/app/dashboard/fiscal-permission.ts src/app/api/dashboard/fiscal src/app/api/pos/v1/sales src/app/dashboard/fiscal
git commit -m "feat(fiscal): fiscal:manage (owner) + masked config API + POS fiscal-status endpoint + config dashboard"
```

  **as-built (2026-08-31):** one commit, and it also stages what the sketch above does not list — `package.json`/`package-lock.json` (the `zod` declaration), `vercel.json` + `src/app/api/fiscal/` + `src/app/api/notifications/worker/route.ts` (the dedicated fiscal cron and the single-ownership move), `src/server/audit/coverage.ts` (`config-service.ts` joins `AUDITED_SERVICE_FILES` with **real present coverage**: both its writers are exported and both emit, so no new allowlist entry was needed), and `src/components/dashboard/{nav-items,nav-items.test,DashboardNav}.ts(x)` + `src/app/dashboard/layout.tsx` (the country-gated nav entry). Actual message: `feat(fiscal): fiscal:manage config service + dashboard/POS routes, dedicated 15-min fiscal cron` — no trailers, per house convention.

  **Two new audit actions ship with it**, per this task's brief: `eta.config.updated` (entity `eta_tenant_config`) and `eta.device_credentials.updated` (entity `eta_pos_credential`), both with metadata that names the **fields** that changed and never their values — audit rows are readable by every `audit:view` holder, a wider audience than `fiscal:manage`. Plus `eta.submission.resubmission_requested`, which is the allowlist debt described in Step 6.

---

## Task 7: `Receipt.tsx` renders the ETA UUID + QR

Once the fiscal block resolves to `accepted`, the receipt shows the ETA **QR** (from the server-generated `qrImageDataUrl`) and the **UUID**; while `pending`/`submitted` it shows "Fiscal receipt pending"; on `rejected` a non-blocking notice (the sale stands — the fix is a resubmit). A reprint renders the **stored** UUID/QR and never re-submits. For a refund, the accompanying credit-note references the original receipt's UUID (rendered on the refund slip once its `credit_note` is accepted).

> **STALE, CORRECTED IN THE AS-BUILT NOTES BELOW:** "once the fiscal block resolves to `accepted`" is the pre-addendum rule. The QR + UUID print **as soon as `qrImageDataUrl` exists — at `pending`** — because `finalize` runs inline at sale time and ETA is post-clearance: the customer's copy must carry the code at issuance (addendum C5, and the Task 6 route test pins a `pending` row that already has a QR). "Fiscal receipt pending" is only for a row with **no QR yet**.

**Files:**
- Modify: `apps/pos/src/screens/Receipt.tsx`
- Test: `apps/pos/src/screens/Receipt.test.tsx` (create if absent, following the POS renderer test convention)

**Files as built:** `apps/pos/src/screens/Receipt.tsx` (+ `Receipt.test.tsx`), `apps/pos/src/fiscal/sale-fiscal.ts` (+ `sale-fiscal.test.ts` — the bounded poll), `apps/pos/src/screens/OrderScreen.tsx` (post-sale owner) and `apps/pos/src/screens/SalesHistory.tsx` (reprint slip), plus the IPC channel: `apps/pos/electron/pos-main.ts`, `preload.ts`, `main.ts` (+ `pos-main.test.ts`, the URL/header pin).

**Interfaces:**
- Consumes: the Task 6 `GET /api/pos/v1/sales/:orderId/fiscal` payload.
- Produces: `ReceiptData` gains an optional `fiscal?: { status: "pending" | "submitted" | "accepted" | "rejected" | "failed"; etaUuid: string | null; qrImageDataUrl: string | null }` block. The screen polls the fiscal endpoint after the sale and re-renders when it resolves.

- [x] **Step 1: Write the failing renderer tests.** In `apps/pos/src/screens/Receipt.test.tsx`, render `Receipt` with three fiscal states and assert:
  - `accepted` → the UUID text and an `<img>` with the `qrImageDataUrl` `src` are present.
  - `pending`/`submitted` → a "Fiscal receipt pending" line, no QR.
  - `rejected` → a non-blocking notice; the sale total/tenders still render unchanged.
  - No `fiscal` block (non-EG tenant) → the receipt renders **exactly as today** (no fiscal footer) — the country-gate no-behavioural-change guarantee.

  **as-built (2026-08-31) — THE `pending` ROW ABOVE IS WRONG AND WAS NOT BUILT.** The QR renders **whenever `qrImageDataUrl` is present, including at `pending`**, per the addendum's QR-at-issuance rule (which this plan's header says wins) and per the Task 6 route test, which pins a `pending` row that already carries a QR because `finalize` runs inline at sale time. Gating the image on `accepted` would print a blank customer copy on every EG sale and only ever show the code on a reprint. "Fiscal receipt pending" is now the narrower case it should always have been: **a row that exists but has no QR yet** (unfinalized — rare). `rejected` KEEPS the QR and uuid and adds the note beside them; `failed` prints like any other in-flight state, since the worker is still retrying it.

  **There is no DOM/render harness in this workspace** (no jsdom, no Testing Library — `SyncBadge.test.ts` says as much and tests pure helpers instead). Rather than add one, the tests render with **`react-dom/server`'s `renderToStaticMarkup`**, which `react-dom` (already a devDependency) provides: that makes "renders exactly as today" an exact **string equality** against a baseline rendered with no `fiscal` prop at all — the strongest available form — and lets every other state assert `withoutFooter(html) === baseline`, i.e. the sale body is character-for-character unchanged. 7 tests.

- [x] **Step 2: Run to verify they fail.** `cd apps/pos && npx vitest run src/screens/Receipt.test.tsx`. Expected: FAIL — `fiscal` not rendered.

  **as-built:** run as a red-state check on the **sketch in Step 3 below** rather than on an empty footer — the footer was written first, then the condition temporarily swapped to the sketch's `status === "accepted" && qrImageDataUrl`. **4 of 7 failed** (`pending`, `submitted`/`accepted`, `rejected`, `failed` all lost the `<img>`), which is exactly the correction this task carries; reverted and re-ran green. The `null`/absent-fiscal test passes under both, as it must.

- [x] **Step 3: Implement.** Add the `fiscal?` field to `ReceiptData` and a fiscal footer below the "Thank you!" line:

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

  **as-built (2026-08-31) — what actually shipped, and the data-flow path it mirrors.**

  **`fiscal` is a PROP of `Receipt`, not a field of `ReceiptData`** (`ReceiptData` is untouched). The receipt data is a snapshot of the sale, settled the moment it was rung; the fiscal block arrives afterwards and changes under it. Keeping them apart also makes the no-behavioural-change guarantee structural — a screen that passes no prop renders the pre-ETA markup byte for byte. The footer is its own exported component, `ReceiptFiscalFooter`, so the **reprint slip** (which renders its own receipt markup inside `SalesHistory.tsx`, not `Receipt`) shows the same block from the same code. It sits INSIDE `#receipt` so the print stylesheet's `#receipt *` rule keeps the QR on the paper copy.

  **The renderer never talks to the server directly** — it has no device token. Every server call rides main: `PosMain` method → `ipcMain.handle("pos:…")` in `electron/main.ts` → `contextBridge` method in `electron/preload.ts` → `window.pos.…`. This task adds one channel by mirroring `reprintReceipt` exactly, its nearest sibling: **`PosMain.saleFiscalStatus(orderId)`** does `fetch(`${baseUrl}/api/pos/v1/sales/${orderId}/fiscal`, { headers: this.authHeaders() })` — the same device `Authorization` + `X-POS-Cashier` pair the route's `requirePosCashier` needs — plus `pos:saleFiscalStatus` in `main.ts` and `saleFiscalStatus` on `PosBridge`. Unlike `reprintReceipt` it **never throws**: it answers `null` for no pairing, no cashier, an unreachable backend, a non-2xx, and for the endpoint's own literal `null` body, because the receipt does the same thing with all of them — prints as a non-fiscal till would. That is `getOrders`'s swallow-and-degrade shape, chosen for the same offline-first reason.

  **The poll lives in `apps/pos/src/fiscal/sale-fiscal.ts`, not in a component**, so it is testable without a render harness: `startSaleFiscalPoll(orderId, onFiscal, opts)` is a plain imperative loop returning its canceller, and `useSaleFiscal(orderId)` is a four-line hook over it. **The bound is the load-bearing part.** `accepted`/`rejected` are terminal; **`failed` is not** — the worker retries it — so "poll until it stops being failed" would poll forever against a permanently failed row. It polls every **3s** and stops at the **first** of: holding the QR **and** a terminal status, or **30s** elapsed (11 polls, the last landing on the cap). The verdict is minutes-to-hours away under post-clearance, so the till must not wait for it; the footer simply shows what it holds when polling stops. Because the endpoint re-encodes the same PNG on every call, `onFiscal` fires **only when a rendered field actually changed**, so the QR is rendered once and never churned.

  **`OrderScreen` owns the post-sale flow** (`if (receipt) return <Receipt …>`). It keeps `fiscalOrderId`, set **after** `recordSale` resolves and only when `synced` — an unsynced offline sale has no server order id to look a record up by, so it prints unchanged — and cleared by "New order", which cancels the poll. **Nothing on the checkout path is awaited on fiscal:** the sale commits, the receipt renders, and the first poll goes out from an effect afterwards. **`SalesHistory`'s reprint** calls `fetchSaleFiscal(sale.id)` **once**, after the slip is already on screen and outside its busy/`finally` window — a read, never a submission, with nothing to wait for.

- [x] **Step 4: Run to verify they pass.** `cd apps/pos && npx vitest run src/screens/Receipt.test.tsx && npx tsc --noEmit`. Expected: PASS, clean.

  **as-built:** whole POS suite `npm --prefix apps/pos run test` → **157 passed / 13 files** (baseline 135/11: +8 `Receipt.test.tsx`, +12 `src/fiscal/sale-fiscal.test.ts`, +2 `electron/pos-main.test.ts`; the last three arrived with the review follow-ups below). `npm --prefix apps/pos run typecheck` (both `tsconfig.json` and `tsconfig.node.json`) clean. No root files touched, so the root `tsc`/`eslint` gates are unaffected. The poll tests drive fake timers through the cap and pin the four things a client gets wrong here: it stops at terminal+QR, it stops at the cap on `submitted`, it does **not** loop forever on `failed`, and a literal `null` body is the ordinary no-record answer rather than an error. **`PosMain.saleFiscalStatus` is pinned at the transport boundary** (added in the follow-up commit). `pos-main.test.ts` does exercise `PosMain` for real — it is the pairing/unpairing suite — but until now **no test asserted a URL or a header for any `PosMain` method**, and this method's never-throws design turns a URL typo into a permanent silent no-footer rather than an error anyone would see. So one test signs a cashier in and asserts the exact `${baseUrl}/api/pos/v1/sales/<id>/fiscal` and both auth headers, and a second asserts the no-cashier guard makes no request at all. The endpoint itself is route-tested server-side.

- [x] **Step 5: Commit.**

```bash
git add apps/pos/src/screens/Receipt.tsx apps/pos/src/screens/Receipt.test.tsx
git commit -m "feat(pos): Receipt renders ETA UUID + QR once accepted, pending/rejected notices otherwise"
```

  **as-built:** the message is `feat(pos): receipt fiscal footer — ETA QR + UUID at issuance, bounded status poll` (the sketch's "once accepted" is the stale rule this task corrects). It also stages what the sketch does not list: `apps/pos/src/fiscal/sale-fiscal.ts` + its test, `apps/pos/src/screens/{OrderScreen,SalesHistory}.tsx`, and the three main-process files that carry the new IPC channel (`electron/{pos-main,preload,main}.ts`). No trailers, per house convention.

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
- [ ] VERIFY 9 — **uuid blanking rule** (raised by Task 3a; the single assumption to confirm against ETA preprod before go-live). The FAQ's "empty receipt UUID" + "all its properties" reads as **keeping** the `uuid` key with an empty value (what `computeReceiptUuid` implements, hashing `"UUID"""`), while the core-fields validator's "excluding the UUID itself" could mean **dropping** the property — a different hash, and ETA's own sample receipt carries a placeholder uuid so it cannot settle it. One line in `computeReceiptUuid`. See the addendum's §5 ledger row 9 and §6.
- [ ] VERIFY 10 — **Offline issuance without a QR** (raised by Task 7). An EG sale rung while the till is offline prints with **no fiscal footer** — the submission is enqueued server-side at sync, so there is no uuid or QR to print at the counter — and only the reprint carries the code; whether a QR-less customer copy is acceptable at issuance, or whether the till must compute the chain locally, is an ETA/tax-adviser question. See the addendum's §5 ledger row 10.

_No commit for this section — it is a gate, not a change. Do not remove a `TODO(VERIFY)` marker without linking the confirming ETA documentation in the commit that removes it._

---

## Task 8: Full-suite verification and manual acceptance

**Files:** none — this task changes nothing. It proves the spec.

- [x] **Step 1: Run everything.** *(As-built 2026-08-31: root suite **1556/1556** after the two final-review fix rounds (**1543/1543** at first measurement) — incl. the once-flaky `offline-lifecycle` test, green; `npx tsc --noEmit` clean; `npx eslint src` = exactly the **6 pre-existing** `no-html-link-for-pages` errors in 5 files untouched on this branch (`git diff main...HEAD` empty for each) — documented debt, not a regression; apps/pos **157/13** + both typechecks clean; `npx next build` clean, **9** fiscal paths dynamic (7 at first measurement; +2 tax-code routes in the final-review rounds); `npm run db:migrate:test` **51/51**.)*

- [ ] **Step 2: Walk the spec's acceptance path** (on a tenant with `country="EG"` and an `active` `eta_tenant_config`, POS paired):
  - [x] Classify a product in `product_tax_codes`; ring a sale of it → an `eta_submissions` row `docType='e_receipt'`, `status='pending'` appears; the **sale returns immediately** (no ETA wait). *(Evidence: `enqueue.test.ts` EG-sale-via-real-`recordSale` test; finalize-at-enqueue also stamps uuid+QR — `worker.test.ts` accept path.)* **Corrected 2026-08-31 (final-review I3): the first clause of this step had no product surface behind it.** `product_tax_codes` had readers (the document builder throws `MissingTaxCodeError` without a row) and NO writer anywhere in the codebase, so "classify a product" was reachable only by hand-writing SQL — i.e. this box was ticked on evidence that the *sale* half worked, while the *classification* half could not be performed by a tenant at all. A write surface now exists: `listProductTaxCodes` / `upsertProductTaxCode` (config-service), `GET /api/dashboard/fiscal/tax-codes` + `PUT /tax-codes/[productId]`, and a Tax codes section on the fiscal dashboard listing classified products and naming the unclassified ones. Deliberately NOT the spec's deferred bulk-EGS-lookup UI — no code search, no catalogue import, no approval polling, all of which need ETA's codes API. *(Added evidence: `config-service.test.ts` classify/re-classify + shape-rejection + cross-tenant-product + audit-emission + tenant-scoped-read tests; `fiscal-routes.test.ts` tax-code 403 / list / classify / 400-ladder tests.)*
  - [x] Run the worker with a stubbed accepting provider → the row flips to `accepted` with `etaUuid` + `qrPayload`; `/api/pos/v1/sales/[id]/fiscal` returns them; the receipt renders the QR + UUID. *(Evidence: `worker.test.ts` accept path; read-model status-flow test via real `recordSale`; POS route test; `Receipt.test.tsx` — QR renders from `pending` onward per addendum C5.)*
  - [x] Ring a sale of an **unclassified** product → the sale still completes; the worker marks the row `failed` with a product-naming `lastError` and the owner is notified. The sale is **not** blocked. *(Evidence: `worker.test.ts` MissingTaxCodeError → permanent-fail + notify-once tests.)*
  - [x] Issue a Spec 3 refund on the accepted receipt → a **`return_receipt`** row (as-built per addendum C4 — not `credit_note`) referencing the parent `etaUuid` is enqueued atomically and, after the worker (deferral until the parent is `accepted`), accepted. *(Evidence: `enqueue.test.ts` refund-path atomicity; `worker.test.ts` return-deferral + acceptance.)* **Extended 2026-08-31 (final-review C1):** the original evidence used an ITEMISED refund, while both POS surfaces default to `kind:"full"` with `lines: []` — a shape that stores no `refund_lines` and was therefore filing no return document at all. Headerless full refunds now resolve their lines from the parent order; covered end-to-end by `worker.test.ts`'s full-refund, full-after-partial and goodwill cases.
  - [x] Ring a sale on a **non-EG** tenant → **no** `eta_submissions` row, and the receipt renders with no fiscal footer. *(Evidence: `enqueue.test.ts` country gate; `Receipt.test.tsx` exact-string-equality baseline — byte-identical output.)*
  - [ ] Ring an EG sale with the till **offline** → the receipt prints with **NO fiscal footer**; after sync, a reprint carries the QR + UUID. Confirm the compliance stance on the QR-less original with ETA/a tax adviser before go-live (VERIFY 10).
  - [x] Confirm `GET /api/dashboard/fiscal/config` **never** returns a secret; a `manager`/`staff` user gets **403**. *(Evidence: mutation-verified deep masking walk over every read surface + audit rows; route 403 tests; `redactedCause` log-redaction test.)*
  - [ ] Confirm the Vercel plan tier supports sub-daily cron (`*/15` fiscal worker) BEFORE enabling any EG tenant — Hobby tier silently runs daily; see `/api/fiscal/worker/route.ts` comment.

- [x] **Step 3: Open the PR.** *(Opened 2026-08-31 as https://github.com/Ai-NativeLab/ServeOs/pull/198 with the as-built body below — it supersedes the original template, which predated the addendum and carried an attribution footer contrary to repo commit policy.)*

```bash
git push -u origin HEAD
gh pr create --title "feat(fiscal): ETA e-invoicing & e-receipts behind a FiscalProvider (EG-gated, async, non-blocking)" --body "$(cat <<'EOF'
Implements Spec 11 (roadmap D8): Egyptian Tax Authority e-receipts for POS + online
sales behind a FiscalProvider interface. Authority: the 2026-08-30 verified-findings
addendum (docs/ailab/specs/) — every wire claim traces to official ETA SDK pages,
with ETA's published serialization example committed as a CI golden vector.

WHAT SHIPPED (the branch's signed commits, task-by-task with two-stage review on each):
- Schema: 5 FORCE-RLS tables (submissions outbox, product tax codes, tenant config,
  per-device uuid chains, per-device POS credentials), partial unique arbiters that
  admit corrected resubmissions, parent XOR CHECK, RESTRICT FKs for 5-year retention.
- Contract: FiscalProvider (buildReceipt/buildReturnReceipt pure; submit/poll async)
  with a wire-agnostic money model mapped verbatim from order figures (F9).
- Wire core: receipt v1.2 mapping, canonical serialization byte-identical to ETA's
  published example, client-side SHA-256 uuid chained per device, QR at issuance,
  exact largest-remainder VAT allocation with ETA's validation equations enforced
  fail-closed (T4, buyer-id threshold, fee lines as itemData since feesAmount must
  be zero).
- Transport: POS token client (4 auth headers, single-flight login, 60s abort),
  submit/poll mapped to the three-family error taxonomy, substring secret redaction,
  preprod CA seam (never TLS-disable), request_json stored as `json` (jsonb reorders
  keys and would corrupt the hash — caught in review).
- Pipeline: finalize-at-enqueue (uuid+QR exist at sale time; sale is NEVER blocked),
  15-min cron worker with lease-based claim (lease + timeout < ETA's ~10-min duplicate
  window, documented), the 24h window surfaced as a read-layer overdue flag
  (deliberately not enforced at the worker — stopping at the deadline would turn a
  late document into no document), a reconciliation sweep that is BOTH the detection
  surface for row-less failures AND the primary enqueue path for paid online orders
  (7-day horizon), a headerless full-refund resolver (remaining-quantity lines,
  largest-remainder gross split — pro-rata simplification documented), and
  dashboard-triggered corrected resubmission with actor audit.
- Config surface: fiscal:manage (owner-only), Zod-validated wire context/devices,
  write-only credential refs (env:// enforced on save) with mutation-verified masking,
  status-count chips, and the product tax-code write surface (list/upsert + dashboard
  section, unclassified products lead — the day-one unblock).
- POS: receipt fiscal footer (QR at pending-finalized), bounded 30s poll, offline
  degrades silently, non-EG receipts byte-identical.

VERIFICATION: root 1556/1556 · apps/pos 157/13 · migrations 51/51 · next build clean (9 fiscal paths) ·
eslint = 6 pre-existing errors in files untouched here (documented debt).

GO-LIVE GATES (no code can close these — see plan "Blocked — VERIFY" + addendum §5):
- VERIFY 9: uuid blanking rule (one line in computeReceiptUuid) — confirm on ETA preprod.
- VERIFY 10: EG offline sales print without a QR (reprint carries it after sync) —
  ETA/tax-adviser question; mirrors ZATCA PRD-003 Q3.
- Vercel tier must support sub-daily cron (*/15) — Hobby silently runs daily.
- Per-tenant: real registration (tax office / e-seal), B2C tag, device serials at
  pos.eta.gov.eg — activationStatus gates all submission until then.
- ONLINE CHANNEL: web/WhatsApp orders have no recordSale hook, so they fiscalise via
  reconcileMissingReceipts — enqueued ~5-20 min after payment (eligibility delay +
  15-min cron), well inside ETA's 24h window but NOT at commit. The customer's online
  confirmation therefore carries no uuid and no QR. A storefront fiscal surface is a
  named product follow-up (addendum §6, VERIFY-10-adjacent), not a pipeline defect.

DECISIONS FOR PRODUCT REVIEW (deliberate, documented in addendum §6):
- Returns carry no VAT reversal (refund tables store no VAT) — tenants over-declare
  output VAT on refunds until Spec 3 stores it. LIVE FISCAL EXPOSURE, flagged.
- Order-level VAT is allocated per line (largest remainder, exact reconciliation).
- zod is now a declared runtime dependency (and moved 4.4.3 → 4.5.4).
- Goodwill full refunds (total < outstanding net-paid) are deliberately REFUSED
  (IrreconcilableOrderError) — inventing which items came back would be inventing
  tax; they surface as permanent failures for the owner to resolve.
Follow-up tickets noted in-repo: audit-scanner private-helper widening (8 pre-existing
gaps outside fiscal), transitive global-db read in the refund tx (pre-existing),
date-filtered submissions listing.
EOF
)"
```

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

**Forward note — date-filtered submissions listing (quality review, finding 7, 2026-08-31).** `listSubmissions` filters by `status` and paginates, which is enough for "show me today's rejections" only while a tenant's history is short. A tenant reconciling a VAT period needs a date range (`createdAt`/`acceptedAt` between X and Y), and a filing period is precisely the window nobody can reach by paging back through 25-row pages. Deferred rather than guessed at because the useful shape depends on the reconciliation surface it feeds — per-period export, a report, or a filter on this table — and none of those exists yet. `getSubmissionStatusCounts` covers the "how many rejections exist at all" question this task actually needed. When it lands: the `eta_submissions_claim` index is on `(status, next_attempt_at)`, so a tenant-scoped date range would want its own index rather than riding that one.

**Deliberate deferrals (matching the spec's Non-goals):** the **B2B e-invoice trigger** (buyer tax-registration capture at the till) is schema/provider-ready (`docType='e_invoice'`) but not wired — consumer `e_receipt` is v1. The **credit-note enqueue** lives inside Spec 3's `issueRefund`; if Spec 3 is not yet on the branch when this lands, Task 4 Step 5 leaves a marked hook and the credit-note worker path is covered by fixtures until Spec 3 merges. **Scheduling** `drainEtaSubmissions` reuses Spec 5's outbox scheduler; if that scheduler is not present, the function is complete and callable and a `TODO` marks the wire-up.

**Dependency posture:** `recordAuditEvent` (Spec 4) and `notify` (Spec 5) are called through `src/server/fiscal/effects.ts`, which no-ops if the module is absent — so this PR stays green whether or not Specs 4/5 have merged, and upgrades to real audit/notify automatically once they do (mirroring Spec 3's graceful degradation against Spec 8).

**Type consistency:** `FiscalDocument` / `FiscalSubmitResult` / `EtaConfig` (Task 2) are the exact types `buildReceipt`/`buildCreditNote` and `EtaFiscalProvider.submit` produce/consume (Task 3), the worker persists (Task 5), and the config/read services surface (Task 6). `EnqueueInput`'s `docType` is the `eta_doc_type` enum from Task 1. The `ReceiptData.fiscal` block (Task 7) is exactly the `getSaleFiscalStatus` return shape (Task 6). Nothing crosses a task boundary as `any`, and the ETA-specific wire format is the **only** thing left `TODO(VERIFY)` — every ServeOS-side type is closed.
