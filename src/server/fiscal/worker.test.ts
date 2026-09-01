import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { orders, orderItems } from "@/server/ordering/schema";
import { placeOrder } from "@/server/ordering/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { auditEvents } from "@/server/audit/schema";
import { notifications } from "@/server/notifications/schema";
import { FakeEmailProvider } from "@/server/email/fake-provider";
import { seedPosContext, openShiftForCtx } from "@/server/pos/test-helpers";
import { recordSale } from "@/server/pos/record-sale";
import { issueRefund, type RefundActor } from "@/server/pos/refund";
import { refundLines, refunds } from "@/server/pos/refund-schema";
import { getCheckoutPricing, setPricesIncludeVat, setServiceChargeRate } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import type { PosCashierContext } from "@/server/pos/require-cashier";
import {
  etaSubmissions, etaTenantConfig, etaPosCredentials, etaDeviceChains, productTaxCodes,
  type EtaWireContextConfig, type EtaDocType,
} from "./schema";
import { drainEtaSubmissions, MAX_ATTEMPTS } from "./worker";
import { SUBMISSION_WINDOW_MS } from "./constants";
import { getSubmissionById, listSubmissions } from "./read-model";
import { finalizeSubmissionRow, reconcileMissingReceipts } from "./finalize";
import { enqueueCorrectedResubmission } from "./enqueue";
import { BuyerIdRequiredError } from "./errors";
import { TestCertSigner } from "./sign-invoice";
import { stringifyWire } from "./serialize";
import { EtaTransportError, EtaConfigError } from "./eta-transport-errors";
import type {
  EtaConfig, FinalizedFiscalDocument, FiscalProvider, FiscalSaleInput, FiscalRefundInput, FiscalInvoiceInput, FiscalInvoiceBuyer, FiscalSubmitResult,
} from "./provider";

/**
 * Runs against the real test Postgres, seeding through the real service
 * functions (`seedPosContext`, `recordSale`, `issueRefund`, `placeOrder`) the
 * way `enqueue.test.ts` does — so RLS, the FKs and the partial unique indexes
 * are all exercised for real. Only ETA itself is faked, at the one seam the
 * `FiscalProvider` contract puts a network call behind.
 */

const SECRET_KEYS = {
  erp: "TEST_WORKER_ETA_ERP_SECRET",
  secret1: "TEST_WORKER_ETA_SECRET_1",
  secret2: "TEST_WORKER_ETA_SECRET_2",
  psk: "TEST_WORKER_ETA_PSK",
} as const;

beforeAll(() => {
  process.env[SECRET_KEYS.erp] = "erp-secret";
  process.env[SECRET_KEYS.secret1] = "device-secret-1";
  process.env[SECRET_KEYS.secret2] = "device-secret-2";
  process.env[SECRET_KEYS.psk] = "device-psk";
});

afterAll(() => {
  for (const key of Object.values(SECRET_KEYS)) delete process.env[key];
});

const WIRE_CONTEXT: EtaWireContextConfig = {
  sellerName: "Fiscal Co",
  activityCode: "5610",
  branchCode: "0",
  branchAddress: {
    country: "EG", governate: "Cairo", regionCity: "Nasr City",
    street: "Test Street", buildingNumber: "12",
  },
  // Receipt v1.2's own feesAmount "accepts only zero values", so a service
  // charge ships as its own itemData line on the SALE — and, once a refund
  // returns it, on the return receipt too.
  feeLines: {
    serviceCharge: {
      itemCode: "1234567890124", codeSource: "gs1", taxType: "T1",
      taxSubType: "V009", unitType: "EA", description: "Service", internalCode: "SVC",
    },
  },
};

// ---------------------------------------------------------------------------
// A fake ETA. Only `submit`/`poll` are real behaviour — the worker builds and
// finalizes through the pure modules directly (see `./finalize`'s header), so
// the build methods here exist to satisfy the interface and would be a bug if
// they were ever reached.
// ---------------------------------------------------------------------------

type SubmitOutcome = FiscalSubmitResult | Error;

class FakeEta implements FiscalProvider {
  readonly name = "fake";
  readonly submitted: FinalizedFiscalDocument[] = [];
  readonly polled: string[] = [];
  /** Which family each poll asked for — the worker must pass the ROW's docType,
   *  because the two families are polled through different ETA APIs. */
  readonly polledDocTypes: EtaDocType[] = [];

  constructor(
    private readonly submitOutcomes: SubmitOutcome[],
    private readonly pollOutcomes: SubmitOutcome[] = [],
  ) {}

  buildReceipt(_input: FiscalSaleInput): never {
    throw new Error("FakeEta.buildReceipt must not be called — finalization uses the pure builders directly");
  }

  buildReturnReceipt(_input: FiscalRefundInput): never {
    throw new Error("FakeEta.buildReturnReceipt must not be called — finalization uses the pure builders directly");
  }

  buildInvoice(_input: FiscalInvoiceInput): never {
    throw new Error("FakeEta.buildInvoice must not be called — finalization uses the pure builders directly");
  }

  async submit(finalized: FinalizedFiscalDocument, _cfg: EtaConfig): Promise<FiscalSubmitResult> {
    this.submitted.push(finalized);
    return unwrap(this.submitOutcomes, this.submitted.length, "submit");
  }

  async poll(submissionUuid: string, _cfg: EtaConfig, docType: EtaDocType): Promise<FiscalSubmitResult> {
    this.polledDocTypes.push(docType);
    this.polled.push(submissionUuid);
    return unwrap(this.pollOutcomes, this.polled.length, "poll");
  }
}

/**
 * The nth scripted outcome. AN OVER-CALL IS AN ERROR, NOT A DEFAULT.
 *
 * IT USED TO CLAMP — `outcomes[Math.min(call, outcomes.length) - 1]`, i.e. every
 * call past the script silently replayed the LAST outcome — and that clamp cost
 * a day of root-cause work. A test scripted for two submits that made three got
 * the second one's result again, so an unscripted extra interaction with ETA
 * looked exactly like a scripted one, and the divergence surfaced two passes
 * later as an unrelated transient failure. The clamp did not make tests pass
 * that should fail; it made the FAILURE ARRIVE SOMEWHERE ELSE, which is worse.
 *
 * A SCRIPT IS A CLAIM ABOUT HOW MANY TIMES ETA IS TOUCHED, and that claim is
 * load-bearing all over this file: "submits exactly once when two drains race
 * it", "re-polls, never re-submits", "does not re-send". Under the clamp those
 * assertions rested on a call log the fake would happily overrun. Now the count
 * is checked at the point of the call, so an extra submit fails as an extra
 * submit.
 *
 * IT SURFACES AS A `failed` ROW, NOT AS AN UNCAUGHT THROW, and that is worth
 * knowing before debugging one: the worker catches every provider error by
 * design (`handleFailure` treats an unrecognised one as retryable), so this
 * message lands in the row's `lastError` rather than escaping the drain. Grep
 * for "exceeds" there when a fiscal test fails for a reason that makes no sense.
 */
function unwrap(outcomes: SubmitOutcome[], call: number, what: string): FiscalSubmitResult {
  if (call > outcomes.length) {
    throw new Error(`FakeEta: call ${call} exceeds ${outcomes.length} scripted outcomes for ${what}`);
  }
  const outcome = outcomes[call - 1];
  if (!outcome) throw new Error(`FakeEta: no scripted ${what} outcome for call ${call}`);
  if (outcome instanceof Error) throw outcome;
  return outcome;
}

/**
 * A provider that makes THIS drain the loser of the one race the claim lease
 * cannot rule out: the lease can expire while a submit is in flight, so a
 * second drain may finish the row while this one is still waiting on ETA.
 *
 * The racing write happens INSIDE submit — mid-flight, exactly where it would
 * really land — and then the call fails, so the worker's terminal write runs
 * against a row another drain has already parked at the attempt cap.
 */
function losingDrain(tenantId: string, failure: Error): FiscalProvider {
  return {
    name: "losing-drain",
    buildReceipt: () => { throw new Error("not used"); },
    buildReturnReceipt: () => { throw new Error("not used"); },
    buildInvoice: () => { throw new Error("not used"); },
    poll: () => { throw new Error("not used"); },
    submit: async () => {
      await withTenant(tenantId, (tx) => tx.update(etaSubmissions)
        .set({ status: "failed", attempts: MAX_ATTEMPTS, lastError: "terminalized by the other drain" })
        .where(eq(etaSubmissions.tenantId, tenantId)));
      throw failure;
    },
  };
}

const accepted202 = (submissionUuid = "sub-1"): FiscalSubmitResult => ({
  status: "submitted", submissionUuid, responseJson: { submissionUUID: submissionUuid },
});

const pollValid = (longId = "LONG-1"): FiscalSubmitResult => ({
  status: "accepted", etaLongId: longId, responseJson: { status: "Valid" },
});

const pollInProgress = (): FiscalSubmitResult => ({ status: "submitted", responseJson: { status: "InProgress" } });

const rejection = (): FiscalSubmitResult => ({
  status: "rejected",
  responseJson: { rejectedDocuments: [{ error: { code: "InvalidTaxpayer", message: "seller RIN is not registered" } }] },
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const actorFrom = (ctx: PosCashierContext): RefundActor => ({
  tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, permissions: [...ctx.permissions],
});

async function seedTaxCode(tenantId: string, productId: string) {
  await withTenant(tenantId, (tx) => tx.insert(productTaxCodes).values({
    tenantId, productId, codeSource: "gs1", itemCode: "1234567890123",
    taxType: "T1", taxSubType: "V009", unitType: "EA",
  }));
}

async function seedFiscalConfig(
  tenantId: string,
  overrides: Partial<typeof etaTenantConfig.$inferInsert> = {},
) {
  await withTenant(tenantId, (tx) => tx.insert(etaTenantConfig).values({
    tenantId,
    registrationNumber: "200173707",
    clientId: "erp-client",
    clientSecretRef: SECRET_KEYS.erp,
    environment: "preprod",
    activationStatus: "active",
    wireContextJson: WIRE_CONTEXT,
    ...overrides,
  }));
}

async function seedDeviceCredential(tenantId: string, deviceId: string, etaSerial = "POS-001") {
  await withTenant(tenantId, (tx) => tx.insert(etaPosCredentials).values({
    tenantId, deviceId, etaSerial, clientId: "device-client",
    clientSecret1Ref: SECRET_KEYS.secret1, clientSecret2Ref: SECRET_KEYS.secret2,
    presharedKeyRef: SECRET_KEYS.psk, posOsVersion: "IOS", posModelFramework: "1", status: "active",
  }));
}

type Fixture = Awaited<ReturnType<typeof seedPosContext>> & { receipt: Awaited<ReturnType<typeof recordSale>> };

/**
 * An EG tenant that can issue a fiscal document, with one paid cash sale.
 *
 * `configureFirst` decides WHEN the fiscal config lands relative to the sale,
 * which is exactly the difference between the two finalization paths.
 * Configured first (the default, and the production path): `recordSale`
 * finalizes the row inline, so the printed receipt carries its uuid and QR.
 * Configured after: the sale-path finalization fails — it logs a
 * `finalize-at-enqueue failed` line, which is expected noise in those tests —
 * and the row reaches the worker unfinalized, exercising the worker's own
 * authoritative fallback.
 */
async function seedSale(
  opts: { configureFirst?: boolean; clientOrderId?: string; signingKeyRef?: string } = {},
): Promise<Fixture> {
  const configureFirst = opts.configureFirst ?? true;
  const fiscalConfig = opts.signingKeyRef ? { signingKeyRef: opts.signingKeyRef } : {};
  const s = await seedPosContext("owner");
  await openShiftForCtx(s.ctx);
  await seedTaxCode(s.tenantId, s.productId);

  if (configureFirst) {
    await seedFiscalConfig(s.tenantId, fiscalConfig);
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
  }

  const receipt = await recordSale(s.ctx, {
    clientOrderId: opts.clientOrderId ?? "sale-1",
    lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: s.total,
    payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total, tenderedAmount: s.total }],
  });

  if (!configureFirst) {
    await seedFiscalConfig(s.tenantId, fiscalConfig);
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
  }

  return { ...s, receipt };
}

const rowsFor = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(etaSubmissions).where(eq(etaSubmissions.tenantId, tenantId)));

const auditsFor = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(auditEvents).where(and(
    eq(auditEvents.tenantId, tenantId),
    inArray(auditEvents.action, ["eta.submission.submitted", "eta.submission.accepted", "eta.submission.rejected"]),
  )));

const notificationsFor = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(notifications).where(eq(notifications.tenantId, tenantId)));

const chainFor = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(etaDeviceChains).where(eq(etaDeviceChains.tenantId, tenantId)));

/** The `header` block of a finalized row's stored wire document. Its values are
 *  all strings, so the mapped (JSON.parse'd) column is enough — the decimal
 *  fidelity that needs `request_json::text` is `storedWireText`'s job. */
function header(requestJson: Record<string, unknown>): Record<string, unknown> {
  return requestJson.header as Record<string, unknown>;
}

/** The row's stored document as raw text — the bytes ETA is meant to receive,
 *  before node-postgres parses `114.00` down to `114`. */
async function storedWireText(tenantId: string, submissionId: string): Promise<string> {
  const rows = await withTenant(tenantId, async (tx) => {
    const res = await tx.execute<{ wire: string }>(
      sql`SELECT request_json::text AS wire FROM eta_submissions WHERE tenant_id = ${tenantId} AND id = ${submissionId}`);
    return res.rows;
  });
  return rows[0].wire;
}

// ---------------------------------------------------------------------------

describe("finalization at enqueue time", () => {
  it("gives a POS sale its uuid, QR and chain head before recordSale returns", async () => {
    const s = await seedSale({ configureFirst: true });

    const [row] = await rowsFor(s.tenantId);
    const [order] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, s.receipt.orderId)));

    expect(row.status).toBe("pending");
    expect(row.etaUuid).toMatch(/^[0-9a-f]{64}$/);
    // The QR the printed customer copy carries — buildable at issuance, long
    // before ETA has seen the document (addendum C5). Its total is the order's
    // own stored money string, trailing zeros and all.
    expect(row.qrPayload).toBe(
      `https://preprod.invoicing.eta.gov.eg/receipts/search/${row.etaUuid}/share/${header(row.requestJson).dateTimeIssued}` +
        `#Total:${order.total},IssuerRIN:200173707`,
    );
    // The stored document is the document — property order and decimal
    // literals preserved, not a jsonb-normalized copy of it.
    const wireText = await storedWireText(s.tenantId, row.id);
    expect(wireText).toContain(`"totalAmount":${order.total}`);
    expect(JSON.parse(wireText).header.uuid).toBe(row.etaUuid);
    // Receipts are not e-sealed today (addendum C7), so this stays null rather
    // than being loaded with the uuid.
    expect(row.hashOrSignature).toBeNull();
    expect(header(row.requestJson).previousUUID).toBe(""); // genesis
    expect(header(row.requestJson).receiptNumber).toBe(String(s.receipt.orderNumber));

    const [chain] = await chainFor(s.tenantId);
    expect(chain.deviceId).toBe(s.ctx.deviceId);
    expect(chain.lastUuid).toBe(row.etaUuid);
  });

  it("chains concurrent finalizations on one device: distinct uuids, second links to the first", async () => {
    // BOTH sales are rung before the tenant is configured, so neither is
    // finalized inline and the two finalizations can be raced deliberately.
    const s = await seedPosContext("owner");
    await openShiftForCtx(s.ctx);
    await seedTaxCode(s.tenantId, s.productId);
    const first = await recordSale(s.ctx, {
      clientOrderId: "chain-a",
      lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: s.total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total, tenderedAmount: s.total }],
    });
    const second = await recordSale(s.ctx, {
      clientOrderId: "chain-b",
      lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: s.total,
      payments: [{ clientPaymentId: "p-2", method: "cash", amount: s.total, tenderedAmount: s.total }],
    });
    await seedFiscalConfig(s.tenantId);
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);

    const queued = await rowsFor(s.tenantId);
    expect(queued).toHaveLength(2);
    expect(queued.every((row) => row.etaUuid === null)).toBe(true);

    // Both at once, on the same device: only the advisory device lock stops
    // them reading the same predecessor.
    await Promise.all(queued.map((row) => finalizeSubmissionRow(s.tenantId, row.id)));

    const finalized = await rowsFor(s.tenantId);
    const uuids = finalized.map((row) => row.etaUuid);
    expect(new Set(uuids).size).toBe(2);

    const bySale = new Map(finalized.map((row) => [row.orderId, row]));
    const rowA = bySale.get(first.orderId)!;
    const rowB = bySale.get(second.orderId)!;
    // Whichever won the lock, the chain is a line and not a fork: exactly one
    // row starts from genesis and the other names its sibling.
    const links = [header(rowA.requestJson).previousUUID, header(rowB.requestJson).previousUUID];
    expect(links).toContain("");
    expect(links.filter((link) => link === "")).toHaveLength(1);
    const chained = links.find((link) => link !== "");
    expect(uuids).toContain(chained);

    const [chain] = await chainFor(s.tenantId);
    // The head is the row that finalized second, not either row arbitrarily.
    expect(chain.lastUuid).toBe(finalized.find((row) => row.etaUuid !== chained)!.etaUuid);
  });
});

describe("drainEtaSubmissions — accept path", () => {
  it("finalizes an unfinalized row, submits it, polls it, and accepts it with audits in the same tx", async () => {
    const s = await seedSale({ configureFirst: false });
    const provider = new FakeEta([accepted202("sub-accept")], [pollValid("LONG-ACCEPT")]);

    const first = await drainEtaSubmissions({ provider, reconcile: false });
    expect(first.processed).toBe(1);

    const [submitted] = await rowsFor(s.tenantId);
    expect(submitted.status).toBe("submitted");
    expect(submitted.submissionUuid).toBe("sub-accept");
    expect(submitted.submittedAt).not.toBeNull();
    // Finalization happened here, in the worker — the row arrived without it.
    expect(submitted.etaUuid).toMatch(/^[0-9a-f]{64}$/);
    expect(provider.submitted[0].uuid).toBe(submitted.etaUuid);
    // The load-bearing round trip: what the provider was handed re-serializes
    // into the exact bytes stored at finalization — property order and decimal
    // literals included, because ETA re-derives the uuid from them.
    expect(stringifyWire(provider.submitted[0].wire)).toBe(await storedWireText(s.tenantId, submitted.id));

    // The poll clock is in the future, so a second pass has to be told the row
    // is eligible again.
    await makeEligible(s.tenantId, submitted.id);
    const second = await drainEtaSubmissions({ provider, reconcile: false });
    expect(second.accepted).toBe(1);
    expect(provider.polled).toEqual(["sub-accept"]);

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("accepted");
    expect(row.etaLongId).toBe("LONG-ACCEPT");
    expect(row.acceptedAt).not.toBeNull();
    expect(row.lastError).toBeNull();

    const audits = await auditsFor(s.tenantId);
    expect(audits.map((a) => a.action).sort()).toEqual(["eta.submission.accepted", "eta.submission.submitted"]);
    expect(audits.every((a) => a.actorType === "system" && a.entityType === "eta_submission")).toBe(true);
    expect(audits.every((a) => a.entityId === row.id)).toBe(true);
  });

  it("re-polls, never re-submits, a row whose poll failed in transit", async () => {
    const s = await seedSale();
    // Submit lands, then the poll dies on the wire — which parks the row as
    // `failed` while ETA is still holding the document.
    const provider = new FakeEta(
      [accepted202("sub-once")],
      [new EtaTransportError("gateway down", { status: 502 }), pollValid("LONG-LATE")],
    );

    await drainEtaSubmissions({ provider, reconcile: false });
    await makeEligibleAll(s.tenantId);
    await drainEtaSubmissions({ provider, reconcile: false });

    const failed = (await rowsFor(s.tenantId))[0];
    expect(failed.status).toBe("failed");
    expect(failed.submissionUuid).toBe("sub-once");

    await makeEligibleAll(s.tenantId);
    await drainEtaSubmissions({ provider, reconcile: false });

    // The load-bearing assertion: ETA was asked what happened, not handed the
    // document a second time. Its duplicate window is ~10 minutes, so a
    // re-submit here would file a second copy of the same receipt.
    expect(provider.submitted).toHaveLength(1);
    expect(provider.polled).toEqual(["sub-once", "sub-once"]);

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("accepted");
    expect(row.etaLongId).toBe("LONG-LATE");
  });

  it("submits a row exactly once when two drains race it — the claim's exclusivity pin", async () => {
    const s = await seedSale({ configureFirst: true });
    const [pending] = await rowsFor(s.tenantId);
    const uuid = pending.etaUuid!;
    // ONE provider shared by both drains, so its call log is the global count.
    const provider = new FakeEta([accepted202("sub-race-a"), accepted202("sub-race-b")]);

    await Promise.all([
      drainEtaSubmissions({ provider, reconcile: false }),
      drainEtaSubmissions({ provider, reconcile: false }),
    ]);

    // this catches losing claim exclusivity (drop SKIP LOCKED -> two submits);
    // it does NOT catch neutering the lease alone, because in-pass row locks
    // serialize the two claims anyway — the lease's cross-pass job is pinned by
    // the notify-once race tests below.
    expect(provider.submitted.filter((doc) => doc.uuid === uuid)).toHaveLength(1);

    const rows = await rowsFor(s.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("submitted");
    expect(rows[0].attempts).toBe(0);
  });

  it("does not consume an attempt while ETA is still processing", async () => {
    const s = await seedSale();
    const provider = new FakeEta([accepted202("sub-slow")], [pollInProgress()]);

    await drainEtaSubmissions({ provider, reconcile: false });
    const [submitted] = await rowsFor(s.tenantId);
    await makeEligible(s.tenantId, submitted.id);
    await drainEtaSubmissions({ provider, reconcile: false });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("submitted");
    expect(row.attempts).toBe(0); // a poll is not an attempt
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("drainEtaSubmissions — rejection", () => {
  it("records the response, names the reason, and alerts the owner; the sale stands", async () => {
    const s = await seedSale();
    const provider = new FakeEta([rejection()]);

    const res = await drainEtaSubmissions({ provider, reconcile: false });
    expect(res.rejected).toBe(1);

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("rejected");
    expect(row.responseJson).toEqual(rejection().responseJson);
    expect(row.lastError).toContain("InvalidTaxpayer");

    const alerts = await notificationsFor(s.tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: "system_alert", severity: "critical", entityId: row.id });

    const audits = await auditsFor(s.tenantId);
    expect(audits.map((a) => a.action)).toEqual(["eta.submission.rejected"]);

    // The sale itself is untouched.
    const [order] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, s.receipt.orderId)));
    expect(order.paymentStatus).toBe("paid");
    expect(Number(order.total)).toBe(s.total);
  });
});

describe("drainEtaSubmissions — the failure taxonomy", () => {
  it("backs off on a transport error, honouring Retry-After as a floor", async () => {
    const s = await seedSale();
    // 20 minutes is far past the 60s the first backoff step would give, so
    // only the floor can produce it.
    const retryAfterSeconds = 20 * 60;
    const now = new Date("2026-08-31T10:00:00.000Z");
    const provider = new FakeEta([
      new EtaTransportError("throttled", { status: 429, retryAfterSeconds, etaErrorCode: "TooManyRequests" }),
    ]);

    const res = await drainEtaSubmissions({ provider, reconcile: false, now: () => now });
    expect(res.failed).toBe(1);

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("EtaTransportError");
    expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + retryAfterSeconds * 1000);
    expect(await notificationsFor(s.tenantId)).toHaveLength(0); // not terminal yet
  });

  it.each(["BadStructure", "MaximumSizeExceeded", "IncorrectSubmitter"])(
    "treats %s as permanent — no retries, one alert",
    async (etaErrorCode) => {
      const s = await seedSale({ clientOrderId: `perm-${etaErrorCode}` });
      const provider = new FakeEta([new EtaTransportError("refused", { status: 400, etaErrorCode })]);

      await drainEtaSubmissions({ provider, reconcile: false });

      const [row] = await rowsFor(s.tenantId);
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(MAX_ATTEMPTS); // parked: the claim query can never see it again
      expect(row.lastError).toContain(etaErrorCode);
      expect(await notificationsFor(s.tenantId)).toHaveLength(1);

      // Proof it is really unreachable: a second pass claims nothing.
      const second = await drainEtaSubmissions({ provider, reconcile: false });
      expect(second.processed).toBe(0);
      expect(await notificationsFor(s.tenantId)).toHaveLength(1);
    },
  );

  it("alerts exactly once when a document exhausts MAX_ATTEMPTS", async () => {
    const s = await seedSale();
    const provider = new FakeEta([new EtaTransportError("gateway down", { status: 502 })]);

    for (let pass = 0; pass < MAX_ATTEMPTS + 2; pass++) {
      const [row] = await rowsFor(s.tenantId);
      await makeEligible(s.tenantId, row.id);
      await drainEtaSubmissions({ provider, reconcile: false });
    }

    const [row] = await rowsFor(s.tenantId);
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    // MAX_ATTEMPTS submissions, then the row is out of reach — no more calls.
    expect(provider.submitted).toHaveLength(MAX_ATTEMPTS);
    expect(await notificationsFor(s.tenantId)).toHaveLength(1);
  });

  it("fails permanently and alerts when the tenant has no wire context", async () => {
    // Unfinalized on purpose: a row that already carries its uuid never
    // re-reads the wire context, so the fault has to be present at
    // finalization to be observable at all.
    const s = await seedSale({ configureFirst: false });
    await withTenant(s.tenantId, (tx) => tx.update(etaTenantConfig)
      .set({ wireContextJson: null }).where(eq(etaTenantConfig.tenantId, s.tenantId)));
    const provider = new FakeEta([accepted202()]);

    await drainEtaSubmissions({ provider, reconcile: false });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.lastError).toContain("wire-context-missing");
    expect(provider.submitted).toHaveLength(0); // never reached the network
    expect(await notificationsFor(s.tenantId)).toHaveLength(1);
  });

  it("passes over a tenant whose ETA config is inactive without claiming its rows", async () => {
    const s = await seedSale();
    const before = (await rowsFor(s.tenantId))[0];
    await withTenant(s.tenantId, (tx) => tx.update(etaTenantConfig)
      .set({ activationStatus: "pending" }).where(eq(etaTenantConfig.tenantId, s.tenantId)));
    const provider = new FakeEta([accepted202()]);

    const res = await drainEtaSubmissions({ provider, reconcile: false });
    // The gate is above the claim, so nothing is even looked at: an
    // onboarding tenant costs one config query per pass, not a claim plus a
    // lease bump on every row it owns.
    expect(res).toMatchObject({ processed: 0, skippedTenants: 1 });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    // Not even the backoff clock moved — no lease was taken.
    expect(row.nextAttemptAt.getTime()).toBe(before.nextAttemptAt.getTime());
    expect(provider.submitted).toHaveLength(0);
    expect(await notificationsFor(s.tenantId)).toHaveLength(0);
  });

  it("submits receipts for a tenant whose UNUSED signing_key_ref is stale", async () => {
    const s = await seedSale({ configureFirst: false });
    // A dangling e-seal reference. The e-seal signs B2B e_invoices and ETA has
    // not deployed receipt signature validation at all, so no receipt reads it
    // — but while resolveEtaConfig resolved it eagerly, this one unset env var
    // failed the whole tenant, and the worker turned that into a PERMANENT
    // failure on every receipt.
    await withTenant(s.tenantId, (tx) => tx.update(etaTenantConfig)
      .set({ signingKeyRef: "TEST_WORKER_ETA_SIGNING_KEY_THAT_IS_NOT_SET" })
      .where(eq(etaTenantConfig.tenantId, s.tenantId)));
    const provider = new FakeEta([accepted202("sub-unsigned")]);

    await drainEtaSubmissions({ provider, reconcile: false });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("submitted");
    expect(row.etaUuid).toMatch(/^[0-9a-f]{64}$/);
    expect(row.lastError).toBeNull();
    expect(await notificationsFor(s.tenantId)).toHaveLength(0);
  });

  it("stays quiet when another drain has already terminalized the row (transient path)", async () => {
    const s = await seedSale();
    // One attempt short of the cap, so THIS drain's failure is the one that
    // would exhaust it and alert — which is the only configuration where a
    // double notify is possible at all.
    await withTenant(s.tenantId, (tx) => tx.update(etaSubmissions)
      .set({ attempts: MAX_ATTEMPTS - 1 }).where(eq(etaSubmissions.tenantId, s.tenantId)));

    // Simulates the one race the lease cannot rule out: it can expire while a
    // submit is in flight, so a second drain can be finishing this row while
    // this one is still waiting on ETA. The fake plays that second drain —
    // writing the terminal state mid-flight — and then fails our call.
    const raceThenFail = losingDrain(s.tenantId, new EtaTransportError("gateway down", { status: 502 }));

    await drainEtaSubmissions({ provider: raceThenFail, reconcile: false });

    const [row] = await rowsFor(s.tenantId);
    // The compare-and-set on the attempt count we read at claim time found
    // nothing to update, so neither the counter nor the alert moved. Without
    // it this drain would have written its own terminal state over the other's
    // and sent a second critical alert for one failure.
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.lastError).toBe("terminalized by the other drain");
    expect(await notificationsFor(s.tenantId)).toHaveLength(0);
  });

  it("stays quiet when another drain has already terminalized the row (permanent path)", async () => {
    const s = await seedSale();
    const raceThenFail = losingDrain(s.tenantId, new EtaConfigError("device-not-registered", "config went away mid-flight"));

    await drainEtaSubmissions({ provider: raceThenFail, reconcile: false });

    const [row] = await rowsFor(s.tenantId);
    // `attempts < MAX_ATTEMPTS` makes the terminal UPDATE the thing that
    // decides who alerts: the loser matches no row and says nothing.
    expect(row.lastError).toBe("terminalized by the other drain");
    expect(await notificationsFor(s.tenantId)).toHaveLength(0);
  });

  it("fails one poison row without stopping its siblings", async () => {
    const s = await seedSale({ clientOrderId: "good-1" });
    // A second sale of a product with NO product_tax_codes row: its document
    // cannot be built at all (MissingTaxCodeError, permanent).
    const poisonProduct = await seedUnclassifiedProduct(s.tenantId);
    const poison = await recordSale(s.ctx, {
      clientOrderId: "poison-1",
      lines: [{ productId: poisonProduct, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: s.total,
      payments: [{ clientPaymentId: "p-poison", method: "cash", amount: s.total, tenderedAmount: s.total }],
    });

    const provider = new FakeEta([accepted202("sub-good")]);
    const res = await drainEtaSubmissions({ provider, reconcile: false });
    expect(res.processed).toBe(2);

    const rows = await rowsFor(s.tenantId);
    const good = rows.find((row) => row.orderId === s.receipt.orderId)!;
    const bad = rows.find((row) => row.orderId === poison.orderId)!;
    expect(good.status).toBe("submitted"); // unaffected by its neighbour
    expect(bad.status).toBe("failed");
    expect(bad.lastError).toContain("missing-tax-code");
    expect(bad.attempts).toBe(MAX_ATTEMPTS);
  });
});

describe("drainEtaSubmissions — online orders", () => {
  it("issues an online order's receipt on the tenant's nominated online device", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId, "POS-ONLINE");
    // Aged past the sweep threshold: nothing enqueues a web order today, so
    // the reconciliation sweep is how one enters the fiscal pipeline.
    const orderId = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30 });

    const provider = new FakeEta([accepted202("sub-web")]);
    await drainEtaSubmissions({ provider, limit: 10 });

    const [row] = await rowsFor(s.tenantId);
    expect(row.orderId).toBe(orderId);
    expect(row.status).toBe("submitted");
    // The serial in the hashed document is the nominated device's.
    expect(((row.requestJson.seller as Record<string, unknown>).deviceSerialNumber)).toBe("POS-ONLINE");

    const [chain] = await chainFor(s.tenantId);
    expect(chain.deviceId).toBe(s.ctx.deviceId);
  });

  it("fails permanently when no online device is nominated", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId); // no onlineDeviceId
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
    await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30 });

    const provider = new FakeEta([accepted202()]);
    await drainEtaSubmissions({ provider, limit: 10 });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.lastError).toContain("no fiscal device configured for online orders");
    expect(await notificationsFor(s.tenantId)).toHaveLength(1);
  });
});

describe("drainEtaSubmissions — reconciliation sweep", () => {
  it("adopts an EG order that has no submission row at all, and ignores a fresh one", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);

    // The row-less failure this sweep exists to catch: an order that was
    // placed and paid, whose enqueue never produced a row.
    const stale = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30 });
    const fresh = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 0 });

    const provider = new FakeEta([accepted202("sub-swept")]);
    const res = await drainEtaSubmissions({ provider, limit: 10 });
    expect(res.reconciled).toBe(1);

    const rows = await rowsFor(s.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(stale);
    expect(rows[0].orderId).not.toBe(fresh);
    // Swept AND finalized in the same pass — the sweep uses the sale path's
    // own entry point, not a bare insert.
    expect(rows[0].etaUuid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enqueues at most `limit` orders in one pass, leaving the backlog for the next", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
    for (let i = 0; i < 5; i++) await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30 });

    // A tenant that has been unconfigured for a while can present a backlog of
    // any size; the sweep must take a bounded bite rather than hold a pass open
    // over thousands of orders.
    const first = await reconcileMissingReceipts({ tenantId: s.tenantId }, { limit: 2 });
    expect(first.enqueued).toBe(2);
    expect(await rowsFor(s.tenantId)).toHaveLength(2);

    // Oldest first, so the backlog drains in issuance order and the receipts
    // closest to ETA's 24-hour window go first.
    const second = await reconcileMissingReceipts({ tenantId: s.tenantId }, { limit: 2 });
    expect(second.enqueued).toBe(2);
    expect(await rowsFor(s.tenantId)).toHaveLength(4);
  });

  it("sweeps an order past the age threshold and leaves one just inside it", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);

    // The threshold exists so an in-flight sale is never swept out from under
    // its own enqueue — a sale whose recordSale has committed but whose
    // after-commit enqueue has not run yet must not be adopted here.
    const older = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 11 });
    const newer = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 9 });

    const res = await reconcileMissingReceipts({ tenantId: s.tenantId }, { olderThanMs: 10 * 60 * 1000 });
    expect(res.enqueued).toBe(1);

    const rows = await rowsFor(s.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(older);
    expect(rows.some((row) => row.orderId === newer)).toBe(false);
  });

  it("does not reach back past the horizon, so activating a tenant never back-submits its history", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);

    const ancient = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 60 * 24 * 30 });
    const recent = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 60 * 24 * 2 });

    const res = await reconcileMissingReceipts({ tenantId: s.tenantId });
    expect(res.enqueued).toBe(1);

    const rows = await rowsFor(s.tenantId);
    // A month-old order would carry a month-old dateTimeIssued — outside ETA's
    // 24-hour window and into the Late Submission path this pipeline does not
    // implement. Recent history still gets adopted.
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(recent);
    expect(rows.some((row) => row.orderId === ancient)).toBe(false);
  });

  it("ignores an unpaid order — no sale, no receipt", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
    await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30, paymentStatus: "unpaid" });

    const res = await drainEtaSubmissions({ provider: new FakeEta([]), limit: 10 });
    expect(res.reconciled).toBe(0);
    expect(await rowsFor(s.tenantId)).toHaveLength(0);
  });

  it("never visits a non-EG tenant", async () => {
    const s = await seedPosContext("owner");
    await db.update(tenants).set({ country: "SA" }).where(eq(tenants.id, s.tenantId));
    await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30 });

    await drainEtaSubmissions({ provider: new FakeEta([]), limit: 10 });
    expect(await rowsFor(s.tenantId)).toHaveLength(0);
  });
});

describe("drainEtaSubmissions — return receipts", () => {
  it("defers a return until its parent sale is accepted, then references the parent uuid", async () => {
    const s = await seedSale({ configureFirst: true });
    const refund = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: (await orderItemIds(s.tenantId, s.receipt.orderId))[0], quantity: 1, amount: 100, restock: false }],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "other",
      clientRefundId: "r-1",
    });

    // Pass 1: the sale submits; the return is deferred with no attempt spent,
    // because its Mandatory referenceUUID does not exist yet.
    const provider = new FakeEta([accepted202("sub-sale")], [pollValid("LONG-SALE")]);
    await drainEtaSubmissions({ provider, reconcile: false });

    let ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === refund.refundId)!;
    expect(ret.status).toBe("pending");
    expect(ret.attempts).toBe(0);
    expect(ret.etaUuid).toBeNull();
    expect(provider.submitted).toHaveLength(1); // the sale only

    // ------------------------------------------------------------------
    // EACH PASS IS AIMED AT ONE ROW, BY STAMPING ONLY THAT ROW'S CLOCK — and
    // the reason is a real flake this test used to carry rather than tidiness.
    //
    // `makeEligibleAll` stamped BOTH rows with the SAME `nextAttemptAt`, so the
    // claim's `ORDER BY next_attempt_at` had a tie to break and both rows landed
    // in one pass. Which one the worker then drove FIRST was unspecified (see
    // `claim`'s own note: a subquery's ORDER BY does not order the outer
    // RETURNING), and the two orders produce different — both CORRECT —
    // outcomes. Sale first: it polls to accepted, and the return, driven later
    // in the SAME pass, finds a genuinely accepted parent and submits. Return
    // first: the parent is still `submitted`, so it defers and submits a pass
    // later. Task 9's `(tenant_id, created_at)` index changed which one the
    // planner preferred, and the pass-2 submit then over-ran a script written
    // for one — surfacing two passes later as an unrelated transient failure.
    //
    // So the sequence below is guaranteed by DATA rather than by planner luck.
    // The return keeps the future `nextAttemptAt` its pass-1 claim leased it,
    // which makes it INELIGIBLE for pass 2 — a WHERE predicate, not an ordering,
    // and therefore not something a planner can reorder. The deferral this test
    // exists to pin is unaffected: it is pass 1 that claims the return against
    // an unaccepted parent and defers it without spending an attempt, and pass 3
    // that submits it. What is deliberately NOT asserted any more is that a
    // return CANNOT submit in the same pass its parent is accepted — that was
    // never true, and believing it was is what made the flake look like a bug.
    // ------------------------------------------------------------------

    // Pass 2: the sale alone is eligible, and it polls to accepted.
    await makeEligible(s.tenantId, (await rowsFor(s.tenantId)).find((row) => row.orderId === s.receipt.orderId)!.id);
    await drainEtaSubmissions({ provider, reconcile: false });
    const sale = (await rowsFor(s.tenantId)).find((row) => row.orderId === s.receipt.orderId)!;
    expect(sale.status).toBe("accepted");
    // The return was not claimed at all, so nothing was handed to ETA for it —
    // the script is still exactly the one submit from pass 1.
    expect(provider.submitted).toHaveLength(1);
    ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === refund.refundId)!;
    expect(ret.status).toBe("pending");
    expect(ret.attempts).toBe(0);

    // Pass 3: the return finalizes against the accepted parent and submits.
    await makeEligible(s.tenantId, ret.id);
    const returnProvider = new FakeEta([accepted202("sub-return")]);
    await drainEtaSubmissions({ provider: returnProvider, reconcile: false });

    ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === refund.refundId)!;
    expect(ret.status).toBe("submitted");
    expect(ret.etaUuid).toMatch(/^[0-9a-f]{64}$/);
    expect(header(ret.requestJson).referenceUUID).toBe(sale.etaUuid);
    // The return chains on the same device as the sale it reverses.
    expect(header(ret.requestJson).previousUUID).toBe(sale.etaUuid);
    expect(header(ret.requestJson).receiptNumber).toBe(`${s.receipt.orderNumber}-R1`);
    expect(((ret.requestJson.documentType as Record<string, unknown>).receiptType)).toBe("r");
  });
});

describe("drainEtaSubmissions — corrected resubmission", () => {
  it("hashes the rejected document's uuid into the correction and chains it after it", async () => {
    const s = await seedSale({ configureFirst: true });
    const rejected = (await rowsFor(s.tenantId))[0];

    await drainEtaSubmissions({ provider: new FakeEta([rejection()]), reconcile: false });
    expect((await rowsFor(s.tenantId))[0].status).toBe("rejected");

    const correctionId = await enqueueCorrectedResubmission({ tenantId: s.tenantId }, rejected.id);
    const provider = new FakeEta([accepted202("sub-correction")]);
    await drainEtaSubmissions({ provider, reconcile: false });

    const correction = (await rowsFor(s.tenantId)).find((row) => row.id === correctionId)!;
    expect(correction.status).toBe("submitted");
    // A correction is a NEW document: its own uuid, carrying the rejected
    // one's as referenceOldUUID — which, being in the wire, is part of the new
    // hash rather than a side note on the row.
    expect(correction.etaUuid).not.toBe(rejected.etaUuid);
    expect(header(correction.requestJson).referenceOldUUID).toBe(rejected.etaUuid);
    // Still on the device's chain, immediately after the document it replaces.
    expect(header(correction.requestJson).previousUUID).toBe(rejected.etaUuid);
    expect(header(correction.requestJson).receiptNumber).toBe(String(s.receipt.orderNumber));

    const [chain] = await chainFor(s.tenantId);
    expect(chain.lastUuid).toBe(correction.etaUuid);
  });
});

describe("drainEtaSubmissions — headerless full refunds", () => {
  /** Drives the sale to `accepted` so a return can reference it. */
  async function acceptTheSale(tenantId: string) {
    await drainEtaSubmissions({ provider: new FakeEta([accepted202("sub-sale")]), reconcile: false });
    await makeEligibleAll(tenantId);
    await drainEtaSubmissions({ provider: new FakeEta([], [pollValid("LONG-SALE")]), reconcile: false });
  }

  it("files a return receipt for a full refund that stores NO refund_lines", async () => {
    const s = await seedSale({ configureFirst: true });
    await acceptTheSale(s.tenantId);

    // Exactly what both POS surfaces send: kind "full", lines []. This is the
    // most common refund shape there is, and it used to file no document at
    // all — buildReturnReceipt threw EmptyReturnReceiptError, the worker made
    // it permanent, and the owner got an alert naming nothing they could fix.
    const refund = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "other",
      clientRefundId: "r-headerless",
    });
    expect(await refundLineCount(s.tenantId, refund.refundId)).toBe(0);

    await makeEligibleAll(s.tenantId);
    const returnProvider = new FakeEta([accepted202("sub-return")], [pollValid("LONG-RETURN")]);
    await drainEtaSubmissions({ provider: returnProvider, reconcile: false });
    await makeEligibleAll(s.tenantId);
    await drainEtaSubmissions({ provider: returnProvider, reconcile: false });

    const ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === refund.refundId)!;
    expect(ret.status).toBe("accepted");

    // The lines came from the PARENT ORDER, and the document totals to the
    // refund's own stored figure — the invariant toWireReceipt enforces.
    const items = ret.requestJson.itemData as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("Margherita");
    expect(items[0].quantity).toBe(1);
    expect(Number(items[0].total)).toBeCloseTo(s.receipt.paidAmount, 2);
    expect(Number(ret.requestJson.totalAmount)).toBeCloseTo(s.receipt.paidAmount, 2);
    expect(header(ret.requestJson).referenceUUID).toBe(
      (await rowsFor(s.tenantId)).find((row) => row.orderId === s.receipt.orderId)!.etaUuid,
    );

    // AND IT REVERSES THE VAT (round 2 Task 2). The refund stored no
    // refund_lines, so its VAT is on `refunds.vatAmount` alone; `finalize`
    // splits that header across the lines it resolved from the order, and the
    // wire carries it as taxableItems + taxTotals.
    const stored = await refundVatAmount(s.tenantId, refund.refundId);
    expect(stored).toBe("14.00"); // 100.00 product, VAT-exclusive 14% -> 114.00 paid
    expect(items[0].taxableItems).toEqual([{ taxType: "T1", subType: "V009", amount: 14, rate: 14 }]);
    expect(ret.requestJson.taxTotals).toEqual([{ taxType: "T1", amount: 14 }]);
    // ETA's published aggregates hold on the return exactly as on the sale:
    // netAmount = Sum(netSale) = totalAmount - the tax reversed.
    expect(Number(ret.requestJson.netAmount)).toBeCloseTo(s.receipt.paidAmount - 14, 2);
    expect(await storedWireText(s.tenantId, ret.id)).toContain('"amount":14.00');
  });

  it("de-tops an itemised full refund's service-charge VAT onto its own return line", () => runWithServiceCharge());

  /**
   * The de-top decision, end to end on real rows: a VAT-INCLUSIVE order under a
   * 10% service charge, refunded in full with ONE item line.
   *
   * `refund-vat.ts` stage [4] tops that line up to the whole remaining 13.51 so
   * the service charge's share is not orphaned — but 13.51 on a 100.00 line
   * reports netSale 86.49, which Main Calculations rule 42 prices at 12.11 and
   * ETA rejects (1.40 out, against a published tolerance of 0.5). So the wire
   * caps the item line at the 12.28 its own money contains and issues the
   * remaining 1.23 on the service-charge line that carries the 10.00 no
   * `refund_lines` row named.
   */
  async function runWithServiceCharge() {
    const s = await seedPosContext("owner");
    await openShiftForCtx(s.ctx);
    await setPricesIncludeVat(s.tenantId, true);
    await setServiceChargeRate(s.tenantId, 10);
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId);
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);

    // Priced AFTER the settings change, so the fixture asserts against the
    // server's own totals rather than a hardcoded number.
    const pricing = await getCheckoutPricing(s.tenantId);
    const total = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1 }], 0).total;
    expect(total).toBeCloseTo(110, 2);

    const receipt = await recordSale(s.ctx, {
      clientOrderId: "sale-svc",
      lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: total, tenderedAmount: total }],
    });
    await acceptTheSale(s.tenantId);

    const [orderItemId] = await orderItemIds(s.tenantId, receipt.orderId);
    const refund = await issueRefund(actorFrom(s.ctx), {
      orderId: receipt.orderId,
      kind: "full",
      // Exactly what the POS refund screen builds: the line's own lineTotal,
      // with the tender covering the whole outstanding balance.
      lines: [{ orderItemId, quantity: 1, amount: 100, restock: false }],
      payments: [{ method: "cash", amount: total }],
      reasonCode: "other",
      clientRefundId: "r-svc",
    });
    // The stored figure IS the topped-up one — this test exists because the
    // wire cannot report it as stored.
    expect(await refundVatAmount(s.tenantId, refund.refundId)).toBe("13.51");

    await makeEligibleAll(s.tenantId);
    await drainEtaSubmissions({ provider: new FakeEta([accepted202("sub-return")]), reconcile: false });

    const ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === refund.refundId)!;
    expect(ret.status).toBe("submitted");
    const items = ret.requestJson.itemData as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[1].description).toBe("Service");
    expect(items.map((line) => (line.taxableItems as { amount: number }[])[0].amount)).toEqual([12.28, 1.23]);
    // Still the stored header, to the cent — the top-up moved, it did not shrink.
    expect(ret.requestJson.taxTotals).toEqual([{ taxType: "T1", amount: 13.51 }]);
    expect(Number(ret.requestJson.totalAmount)).toBeCloseTo(110, 2);
    expect(Number(ret.requestJson.netAmount)).toBeCloseTo(96.49, 2);
  }

  it("resolves a full refund that FOLLOWS a partial one from what is left", async () => {
    // Two units, so a partial can take one and the headerless full refund can
    // take the remainder — the case `issueRefund` permits and the net-paid
    // ceiling bounds.
    const s = await seedPosContext("owner");
    await openShiftForCtx(s.ctx);
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId);
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
    const receipt = await recordSale(s.ctx, {
      clientOrderId: "sale-two-units",
      lines: [{ productId: s.productId, quantity: 2, selectedOptionIds: [] }],
      expectedTotal: s.total * 2,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total * 2, tenderedAmount: s.total * 2 }],
    });
    await acceptTheSale(s.tenantId);

    const [orderItemId] = await orderItemIds(s.tenantId, receipt.orderId);
    await issueRefund(actorFrom(s.ctx), {
      orderId: receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId, quantity: 1, amount: s.total, restock: false }],
      payments: [{ method: "cash", amount: s.total }],
      reasonCode: "other",
      clientRefundId: "r-partial",
    });
    const full = await issueRefund(actorFrom(s.ctx), {
      orderId: receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.total }],
      reasonCode: "other",
      clientRefundId: "r-remainder",
    });

    await makeEligibleAll(s.tenantId);
    const provider = new FakeEta([accepted202("sub-r1"), accepted202("sub-r2")]);
    await drainEtaSubmissions({ provider, reconcile: false });

    const ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === full.refundId)!;
    expect(ret.status).toBe("submitted");
    const items = ret.requestJson.itemData as Record<string, unknown>[];
    // ONE unit, not two: the quantity already returned by the partial is off
    // the table, and the money is this refund's own stored total.
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(1);
    expect(Number(ret.requestJson.totalAmount)).toBeCloseTo(s.total, 2);
  });

  it("refuses to guess which items a goodwill full refund returned", async () => {
    const s = await seedSale({ configureFirst: true });
    await acceptTheSale(s.tenantId);

    // `issueRefund` permits a `full` refund of LESS than the outstanding
    // balance — a goodwill gesture that names no items. There is no honest
    // mapping from that to itemData, so the document is refused rather than
    // invented.
    const goodwill = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: 10 }],
      reasonCode: "other",
      clientRefundId: "r-goodwill",
    });

    await makeEligibleAll(s.tenantId);
    await drainEtaSubmissions({ provider: new FakeEta([accepted202()]), reconcile: false });

    const ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === goodwill.refundId)!;
    expect(ret.status).toBe("failed");
    expect(ret.attempts).toBe(MAX_ATTEMPTS);
    // The alert names both figures, so the owner can see the shape of the fix
    // (itemise the refund) rather than being told a document "failed".
    expect(ret.lastError).toContain("irreconcilable-order");
    expect(ret.lastError).toContain("goodwill");
  });
});

// ---------------------------------------------------------------------------
// Helpers that reach past the service layer, and say why.
// ---------------------------------------------------------------------------

/** Backoff/lease clocks are real timestamps; a test that wants the next pass
 *  to see a row has to move that clock rather than wait out a real minute. */
function makeEligible(tenantId: string, submissionId: string) {
  return withTenant(tenantId, (tx) => tx.update(etaSubmissions)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, submissionId))));
}

function makeEligibleAll(tenantId: string) {
  return withTenant(tenantId, (tx) => tx.update(etaSubmissions)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(eq(etaSubmissions.tenantId, tenantId)));
}

/** The VAT `issueRefund` stored against a refund — the figure the return
 *  receipt reverses, asserted as a STRING so cent-level drift cannot hide. */
async function refundVatAmount(tenantId: string, refundId: string): Promise<string> {
  const rows = await withTenant(tenantId, (tx) => tx.select({ vatAmount: refunds.vatAmount })
    .from(refunds).where(and(eq(refunds.tenantId, tenantId), eq(refunds.id, refundId))));
  return rows[0].vatAmount;
}

/** How many refund_lines a refund actually stored — the whole point of the
 *  headerless case is that this is zero. */
async function refundLineCount(tenantId: string, refundId: string): Promise<number> {
  const rows = await withTenant(tenantId, (tx) => tx.select({ id: refundLines.id }).from(refundLines)
    .where(and(eq(refundLines.tenantId, tenantId), eq(refundLines.refundId, refundId))));
  return rows.length;
}

async function orderItemIds(tenantId: string, orderId: string): Promise<string[]> {
  const rows = await withTenant(tenantId, (tx) => tx.select({ id: orderItems.id }).from(orderItems)
    .where(and(eq(orderItems.tenantId, tenantId), eq(orderItems.orderId, orderId))).orderBy(orderItems.id));
  return rows.map((row) => row.id);
}

/** A published second product with no `product_tax_codes` row — the cheapest
 *  way to make one document in a batch unbuildable. */
async function seedUnclassifiedProduct(tenantId: string): Promise<string> {
  const cat = await createCategory(tenantId, { nameEn: "Sides", nameAr: "جانبية" });
  const product = await createProduct(tenantId, {
    nameEn: "Fries", nameAr: "بطاطس", basePrice: "100", categoryId: cat.id, trackStock: false, stockQuantity: null,
  });
  await updateProduct(tenantId, product.id, { isPublished: true });
  return product.id;
}

/**
 * A web order — no `pos_order_receipts` row, so nothing but the tenant's
 * nominated online device can carry it. `placedAt`/`paymentStatus` are set
 * directly afterwards because no service exposes "this order was placed half
 * an hour ago and paid": the checkout stamps `now()` and the offline-payment
 * flow needs a payment method this fixture does not exercise.
 */
async function placeWebOrder(
  tenantId: string, branchId: string, productId: string,
  opts: { minutesAgo?: number; paymentStatus?: "paid" | "unpaid" } = {},
): Promise<string> {
  const placed = await placeOrder(tenantId, {
    branchId, fulfillmentType: "pickup", customerName: "Web Buyer", customerPhone: "01000000000",
    channel: "web", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
  });

  await withTenant(tenantId, (tx) => tx.update(orders).set({
    paymentStatus: opts.paymentStatus ?? "paid",
    placedAt: new Date(Date.now() - (opts.minutesAgo ?? 0) * 60 * 1000),
  }).where(eq(orders.id, placed.orderId)));

  return placed.orderId;
}

// ---------------------------------------------------------------------------
// B2B invoices, end to end (round 2 Task 3)
//
// The dashboard trigger is Task 4, so these enqueue directly — which is also
// what pins the STAGING CONTRACT that trigger has to satisfy: an `e_invoice`
// row with the buyer in `request_json`, and nothing else.
// ---------------------------------------------------------------------------

/** The env key a signed tenant's `signing_key_ref` points at. Set and deleted
 *  per test, so no other case sees a configured seal. */
const SIGNING_KEY_ENV = "TEST_WORKER_ETA_SIGNING_KEY";

const B2B_BUYER: FiscalInvoiceBuyer = {
  rin: "313717919",
  name: "Receiver Company LLC",
  address: {
    country: "EG", governate: "Cairo", regionCity: "Nasr City",
    street: "580 Clementina Key", buildingNumber: "Bldg. 0",
  },
};

/**
 * Enqueues an `e_invoice` for a sale, capturing the buyer exactly where
 * `finalizeInvoiceRow`'s read seam expects it — `buyer_json` as of migration
 * 0052 (round 2 Task 4), previously staged inside `request_json`. `null`
 * captures NOTHING: a row with the empty `request_json` AND the null
 * `buyer_json` a bare enqueue leaves behind.
 *
 * Deliberately still a direct insert rather than a call to `requestB2bInvoice`:
 * this suite tests the WORKER's contract with the row, and driving it through
 * the trigger would make every case here depend on the dashboard's ladder (and
 * on its best-effort finalize having already run). `config-service.test.ts` owns
 * the trigger end of the seam.
 */
async function enqueueInvoice(tenantId: string, orderId: string, buyer: unknown = B2B_BUYER): Promise<string> {
  const [row] = await withTenant(tenantId, (tx) => tx.insert(etaSubmissions).values({
    tenantId, docType: "e_invoice", orderId, refundId: null,
    status: "pending", attempts: 0,
    requestJson: {},
    buyerJson: (buyer === null ? null : buyer) as FiscalInvoiceBuyer | null,
  }).returning({ id: etaSubmissions.id }));
  return row.id;
}

const invoiceRowsFor = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(etaSubmissions).where(and(
    eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.docType, "e_invoice"))));

/**
 * THE TILL'S OWN B2B PATH (round 2, Task 5) — a sale rung with a business buyer,
 * driven through the REAL `recordSale`, not through a hand-built row.
 *
 * `enqueueInvoice` above stages a row directly because the worker's contract is
 * what those cases are about. These cases are about the opposite end: whether a
 * cashier pressing "Complete sale" with the buyer section filled in produces one
 * document of the right family, with the buyer on it, and nothing else — ever.
 */
async function ringB2bSale(
  opts: { clientOrderId?: string; buyer?: unknown } = {},
): Promise<Awaited<ReturnType<typeof seedPosContext>> & { orderId: string; orderNumber: string }> {
  const s = await seedPosContext("owner");
  await openShiftForCtx(s.ctx);
  await seedTaxCode(s.tenantId, s.productId);
  await seedFiscalConfig(s.tenantId);
  await seedDeviceCredential(s.tenantId, s.ctx.deviceId);

  const receipt = await recordSale(s.ctx, {
    clientOrderId: opts.clientOrderId ?? "b2b-till-1",
    lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: s.total,
    payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total, tenderedAmount: s.total }],
    buyer: (opts.buyer === undefined ? B2B_BUYER : opts.buyer) as never,
  });
  return { ...s, orderId: receipt.orderId, orderNumber: receipt.orderNumber };
}

describe("till B2B capture — one sale, one document family", () => {
  it("files a B2B sale as an e_invoice carrying the buyer, and NEVER an e_receipt", async () => {
    const s = await ringB2bSale();

    const rows = await rowsFor(s.tenantId);
    // EXACTLY ONE ROW. Not "an invoice exists" — the absence of the receipt is
    // half the assertion, and it is the half that makes the sale declared once.
    expect(rows).toHaveLength(1);
    expect(rows[0].docType).toBe("e_invoice");
    expect(rows.some((r) => r.docType === "e_receipt")).toBe(false);

    // The buyer landed in the SAME insert — never an enqueue-then-update, which
    // on the sale path (no transaction to share) would leave a window holding a
    // buyer-less invoice row that can be neither finalized nor re-requested.
    expect(rows[0].buyerJson).toEqual(B2B_BUYER);

    // And it finalized inline, so the row is a real filed document rather than a
    // bare queue entry: ETA assigns the identity, so no uuid and no QR.
    expect(rows[0].requestJson).toMatchObject({ documentType: "I", internalID: s.orderNumber });
    expect(rows[0].etaUuid).toBeNull();
    expect(rows[0].qrPayload).toBeNull();
  });

  it("leaves the ORDINARY consumer sale exactly as it was — no buyer, no behaviour change", async () => {
    // THE LOAD-BEARING REGRESSION PIN. Nothing about a B2C sale may move: the
    // whole B2B branch is selected by `input.buyer` alone, and its absence must
    // reach the same e_receipt, finalized inline with its QR at issuance.
    const s = await seedSale({ clientOrderId: "b2c-unchanged" });

    const rows = await rowsFor(s.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].docType).toBe("e_receipt");
    expect(rows[0].buyerJson).toBeNull();
    expect(rows[0].etaUuid).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].qrPayload).toContain(rows[0].etaUuid!);
  });

  it("still takes the money when the fiscal branch cannot produce a document", async () => {
    // The iron rule, on the branch this task added: the B2B enqueue lives inside
    // `recordSale`'s existing try/catch, so a buyer ETA would refuse cannot cost
    // the cashier a sale the customer has already paid for. (One expected
    // `[fiscal] ... docType e_invoice` line is logged.)
    const s = await ringB2bSale({ clientOrderId: "b2b-bad-buyer", buyer: { rin: "nope" } });

    const [order] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, s.orderId)));
    expect(order.paymentStatus).toBe("paid");

    // The row exists and is an invoice — the failure is visible and named, and
    // is NEVER a silent downgrade to a consumer receipt, which would misdeclare
    // the sale rather than merely fail to declare it.
    const rows = await rowsFor(s.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].docType).toBe("e_invoice");
    expect(rows.some((r) => r.docType === "e_receipt")).toBe(false);
    // The buyer is stored exactly as it arrived, unrepaired, so the row says
    // what was actually captured rather than a cleaned-up version of it.
    expect(rows[0].buyerJson).toEqual({ rin: "nope" });
  });

  it("refuses a malformed till buyer BY NAME, listing the fields to fix", async () => {
    // The till carries no zod (see `enqueueAndFinalizeInvoice`), so the builder
    // is the backstop — and it has to be a NAMED refusal listing the missing
    // fields, because an owner's alert is where this is read. Before Task 5 the
    // only writer was Task 4's zod trigger, so `name.trim()` was safe and an
    // absent `name` threw a bare TypeError saying nothing useful.
    const s = await ringB2bSale({ clientOrderId: "b2b-named", buyer: { rin: "nope" } });
    const [row] = await rowsFor(s.tenantId);

    await expect(finalizeSubmissionRow(s.tenantId, row.id)).rejects.toThrow(BuyerIdRequiredError);
    await expect(finalizeSubmissionRow(s.tenantId, row.id)).rejects.toThrow(/name/);
    await expect(finalizeSubmissionRow(s.tenantId, row.id)).rejects.toThrow(/address\.country/);
  });

  it("SWEEP CLAUSE: a B2B order past the threshold is never swept into a receipt", async () => {
    // THE DETERMINISTIC DOUBLE-FILING THIS CLOSES. The sweep used to look for a
    // missing `e_receipt` specifically, so a B2B order — which has an invoice and
    // no receipt, by design — read as unfiscalised on every pass and would have
    // been adopted into a SECOND document for one sale. Not a race: it fires on
    // every B2B sale that outlives RECONCILE_AFTER_MS.
    const s = await ringB2bSale({ clientOrderId: "b2b-sweep" });
    await withTenant(s.tenantId, (tx) =>
      tx.update(orders).set({ placedAt: new Date(Date.now() - 30 * 60 * 1000) })
        .where(eq(orders.id, s.orderId)));

    const before = await rowsFor(s.tenantId);
    const res = await reconcileMissingReceipts({ tenantId: s.tenantId });

    expect(res.enqueued).toBe(0);
    const after = await rowsFor(s.tenantId);
    expect(after).toHaveLength(before.length);
    expect(after.some((r) => r.docType === "e_receipt")).toBe(false);
  });

  it("SWEEP CLAUSE: an order with NO row at all is still adopted — the sweep still works", async () => {
    // Non-vacuity for the case above. Dropping the docType predicate must not
    // have turned the sweep off; an order carrying nothing is still swept.
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
    const orphan = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30 });

    expect((await reconcileMissingReceipts({ tenantId: s.tenantId })).enqueued).toBe(1);
    const rows = await rowsFor(s.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(orphan);
    expect(rows[0].docType).toBe("e_receipt");
  });
});

describe("B2B e_invoice — finalization", () => {
  it("persists the wire document with NO uuid, NO chain and NO QR", async () => {
    const s = await seedSale({ clientOrderId: "b2b-1" });
    const submissionId = await enqueueInvoice(s.tenantId, s.receipt.orderId);

    const outcome = await finalizeSubmissionRow(s.tenantId, submissionId);
    expect(outcome).toEqual({ status: "invoice-finalized" });

    const [row] = await invoiceRowsFor(s.tenantId);
    // ETA assigns an invoice's identity; nothing local may claim to have one.
    expect(row.etaUuid).toBeNull();
    expect(row.etaLongId).toBeNull();
    // THE NO-QR INVARIANT — there is no invoice QR template at all.
    expect(row.qrPayload).toBeNull();
    // Not signed, and not pretending to be: the CAdES-BES container is BLOCKED.
    expect(row.hashOrSignature).toBeNull();

    const wire = row.requestJson;
    expect(wire.documentType).toBe("I");
    expect(wire.documentTypeVersion).toBe("0.9");
    expect(wire.internalID).toBe(String(s.receipt.orderNumber));
    expect(Object.keys(wire)).not.toContain("signatures");
    expect(Object.keys(wire)).not.toContain("header");
    // The staged buyer survives as the document's own receiver block.
    expect(wire.receiver).toMatchObject({ type: "B", id: B2B_BUYER.rin, name: B2B_BUYER.name });
  });

  it("does NOT advance any device chain — an invoice is issued from no device", async () => {
    const s = await seedSale({ clientOrderId: "b2b-chain" });
    const [before] = await chainFor(s.tenantId);
    await finalizeSubmissionRow(s.tenantId, await enqueueInvoice(s.tenantId, s.receipt.orderId));
    const [after] = await chainFor(s.tenantId);
    expect(after.lastUuid).toBe(before.lastUuid);
  });

  it("stores decimal literals verbatim, so the bytes a signature would cover survive the round trip", async () => {
    const s = await seedSale({ clientOrderId: "b2b-decimals" });
    const submissionId = await enqueueInvoice(s.tenantId, s.receipt.orderId);
    await finalizeSubmissionRow(s.tenantId, submissionId);

    const [order] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, s.receipt.orderId)));
    const text = await storedWireText(s.tenantId, submissionId);
    expect(text).toContain(`"totalAmount":${order.total}`);
    // Property order preserved by the `json` column — `issuer` first, exactly as
    // the mapper emitted it.
    expect(text.startsWith('{"issuer":')).toBe(true);
  });

  it("is idempotent: a second finalization leaves the persisted bytes untouched", async () => {
    const s = await seedSale({ clientOrderId: "b2b-idem" });
    const submissionId = await enqueueInvoice(s.tenantId, s.receipt.orderId);
    await finalizeSubmissionRow(s.tenantId, submissionId);
    const first = await storedWireText(s.tenantId, submissionId);

    expect(await finalizeSubmissionRow(s.tenantId, submissionId)).toEqual({ status: "invoice-already-finalized" });
    expect(await storedWireText(s.tenantId, submissionId)).toBe(first);
  });

  it("refuses permanently, and by name, when no buyer was staged", async () => {
    const s = await seedSale({ clientOrderId: "b2b-nobuyer" });
    const submissionId = await enqueueInvoice(s.tenantId, s.receipt.orderId, null);

    const error = await finalizeSubmissionRow(s.tenantId, submissionId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaConfigError);
    expect((error as EtaConfigError).code).toBe("missing-buyer");
  });

  it("refuses a staged buyer missing a mandatory receiver field", async () => {
    const s = await seedSale({ clientOrderId: "b2b-partial" });
    const incomplete = { ...B2B_BUYER, address: { ...B2B_BUYER.address, governate: "" } };
    const submissionId = await enqueueInvoice(s.tenantId, s.receipt.orderId, incomplete);

    const error = await finalizeSubmissionRow(s.tenantId, submissionId).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("buyer-id-required");
  });
});

describe("B2B e_invoice — the worker's submit/poll path", () => {
  it("submits, then polls, mapping ETA's ASSIGNED uuid and longId into the row", async () => {
    const s = await seedSale({ clientOrderId: "b2b-drain" });
    await enqueueInvoice(s.tenantId, s.receipt.orderId);

    // The sale's own e_receipt row is claimed in the same pass; script both.
    const eta = new FakeEta(
      [accepted202("sub-receipt"), { status: "submitted", submissionUuid: "sub-invoice", etaUuid: "ETA-UUID-1", etaLongId: "ETA-LONG-1", responseJson: {} }],
      [pollValid("LONG-RECEIPT"), { status: "accepted", etaUuid: "ETA-UUID-1", etaLongId: "ETA-LONG-1", responseJson: { overallStatus: "valid" } }],
    );

    await drainEtaSubmissions({ provider: eta, reconcile: false });
    const [afterSubmit] = await invoiceRowsFor(s.tenantId);
    expect(afterSubmit.status).toBe("submitted");
    expect(afterSubmit.submissionUuid).toBe("sub-invoice");
    // Written at SUBMISSION, not at finalization — the invoice model's whole
    // point. The uuid arrives in ETA's 202.
    expect(afterSubmit.etaUuid).toBe("ETA-UUID-1");
    expect(afterSubmit.etaLongId).toBe("ETA-LONG-1");
    expect(afterSubmit.qrPayload).toBeNull();

    // The claim query only reconsiders a submitted row once its poll interval
    // has passed, so wind the clock forward for the poll pass.
    await withTenant(s.tenantId, (tx) => tx.update(etaSubmissions)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(etaSubmissions.tenantId, s.tenantId)));
    await drainEtaSubmissions({ provider: eta, reconcile: false });

    const [accepted] = await invoiceRowsFor(s.tenantId);
    expect(accepted.status).toBe("accepted");
    expect(accepted.etaUuid).toBe("ETA-UUID-1");
    expect(accepted.etaLongId).toBe("ETA-LONG-1");
    // NO QR, for the document's whole life.
    expect(accepted.qrPayload).toBeNull();

    // The worker told the provider WHICH family to poll — the two use different
    // ETA APIs, so getting this wrong would poll the receipt endpoint for an
    // invoice's submission uuid.
    expect(eta.polledDocTypes).toContain("e_invoice");
  });

  it("submits the invoice document itself, with no uuid and no QR attached", async () => {
    const s = await seedSale({ clientOrderId: "b2b-envelope" });
    await enqueueInvoice(s.tenantId, s.receipt.orderId);

    const eta = new FakeEta([accepted202("sub-receipt"), accepted202("sub-invoice")]);
    await drainEtaSubmissions({ provider: eta, reconcile: false });

    const invoice = eta.submitted.find((d) => d.docType === "e_invoice")!;
    expect(invoice.uuid).toBeNull();
    expect(invoice.qrUrl).toBeNull();
    expect(invoice.wire.documentTypeVersion).toBe("0.9");
    expect(invoice.wire.internalID).toBe(String(s.receipt.orderNumber));
  });

  /**
   * THE VERSION FLIP, end to end through the real finalizer and the real
   * signer. A tenant with a usable e-seal ships `documentTypeVersion` "1.0"
   * with a CAdES-BES `signatures` element; one without ships "0.9" and none.
   *
   * REGISTRATION-GATED: the seal here is a self-issued `TestCertSigner`
   * certificate. This proves the plumbing and the container's structure, never
   * that ETA would accept the signature — see `sign-invoice.ts`.
   */
  it("ships v1.0 with a signature when a seal is configured, and v0.9 without", async () => {
    const signer = await TestCertSigner.create();
    // Through the REAL seam: the bundle goes in the env var the tenant's
    // `signing_key_ref` names, and `resolveInvoiceSigner` parses it back out.
    // Nothing is injected past the config layer.
    process.env[SIGNING_KEY_ENV] = signer.pemBundle();
    try {
      const s = await seedSale({ clientOrderId: "b2b-signed", configureFirst: false, signingKeyRef: `env://${SIGNING_KEY_ENV}` });
      await enqueueInvoice(s.tenantId, s.receipt.orderId);
      await finalizeSubmissionRow(s.tenantId, (await invoiceRowsFor(s.tenantId))[0].id);

      const [row] = await invoiceRowsFor(s.tenantId);
      expect(row.requestJson.documentTypeVersion).toBe("1.0");
      // `signatureType`, per ETA's own signed sample — the page's table calls
      // the field `type`.
      const signatures = row.requestJson.signatures as { signatureType: string; value: string }[];
      expect(signatures).toHaveLength(1);
      expect(signatures[0].signatureType).toBe("I");
      expect(signatures[0].value.startsWith("MII")).toBe(true);
      // LAST property, so the signed prefix is still a prefix of what ships.
      expect(Object.keys(row.requestJson).at(-1)).toBe("signatures");
      // Still no local uuid and no QR — signing changes neither.
      expect(row.etaUuid).toBeNull();
      expect(row.qrPayload).toBeNull();
    } finally {
      delete process.env[SIGNING_KEY_ENV];
    }

    // ...and the unsigned control, same code path, no seal configured.
    const plain = await seedSale({ clientOrderId: "b2b-unsigned" });
    await enqueueInvoice(plain.tenantId, plain.receipt.orderId);
    await finalizeSubmissionRow(plain.tenantId, (await invoiceRowsFor(plain.tenantId))[0].id);

    const [unsigned] = await invoiceRowsFor(plain.tenantId);
    expect(unsigned.requestJson.documentTypeVersion).toBe("0.9");
    expect(Object.keys(unsigned.requestJson)).not.toContain("signatures");
  });

  it("fails a signed tenant permanently when the seal material is unusable, never downgrading to v0.9", async () => {
    process.env[SIGNING_KEY_ENV] = "this is not a PEM bundle";
    try {
      const s = await seedSale({ clientOrderId: "b2b-badseal", configureFirst: false, signingKeyRef: `env://${SIGNING_KEY_ENV}` });
      await enqueueInvoice(s.tenantId, s.receipt.orderId);

      const error = await finalizeSubmissionRow(s.tenantId, (await invoiceRowsFor(s.tenantId))[0].id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EtaConfigError);
      expect((error as EtaConfigError).code).toBe("invoice-signing-unavailable");
      // Nothing was written: the row is still unfinalized rather than holding an
      // unsigned document the tenant did not ask for.
      const [row] = await invoiceRowsFor(s.tenantId);
      expect(Object.keys(row.requestJson)).not.toContain("invoiceLines");
    } finally {
      delete process.env[SIGNING_KEY_ENV];
    }
  });

  it("fails permanently, with an owner alert, when the buyer was never staged", async () => {
    const s = await seedSale({ clientOrderId: "b2b-fail" });
    await enqueueInvoice(s.tenantId, s.receipt.orderId, null);

    const eta = new FakeEta([accepted202("sub-receipt")]);
    await drainEtaSubmissions({ provider: eta, reconcile: false });

    const [row] = await invoiceRowsFor(s.tenantId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS); // permanent: no backoff, no retries
    expect(row.lastError).toContain("missing-buyer");
    const alerts = await notificationsFor(s.tenantId);
    expect(alerts.some((n) => n.title === "A fiscal document could not be submitted")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The customer's copy of their fiscal document (round 2, Task 7)
//
// The CONTENT and the RECIPIENT LADDER are pinned in `customer-email.test.ts`,
// which needs no ETA at all. What is pinned HERE is everything that is a
// property of the HOOK rather than of the module: that acceptance triggers a
// send, that it triggers exactly ONE, and — the one that matters most — that a
// send which fails cannot disturb the acceptance it rides behind.
// ---------------------------------------------------------------------------

/** A web order carrying an email at checkout, aged past the sweep threshold so
 *  the reconciliation sweep adopts it — the real online path. */
async function placeWebOrderWithEmail(
  tenantId: string, branchId: string, productId: string, customerEmail: string | null,
): Promise<string> {
  const placed = await placeOrder(tenantId, {
    branchId, fulfillmentType: "pickup", customerName: "Web Buyer", customerPhone: "01000000000",
    ...(customerEmail ? { customerEmail } : {}),
    channel: "web", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
  });
  await withTenant(tenantId, (tx) => tx.update(orders).set({
    paymentStatus: "paid", placedAt: new Date(Date.now() - 30 * 60 * 1000),
  }).where(eq(orders.id, placed.orderId)));
  return placed.orderId;
}

/** Sweep the order in, submit it, then poll it to `accepted` — the two passes a
 *  document needs, with the poll clock nudged between them. */
async function driveToAccepted(tenantId: string, opts: {
  emailProvider?: FakeEmailProvider; submissionUuid?: string;
} = {}) {
  const provider = new FakeEta([accepted202(opts.submissionUuid ?? "sub-mail")], [pollValid("LONG-MAIL")]);
  await drainEtaSubmissions({ provider, limit: 10, emailProvider: opts.emailProvider });
  const [submitted] = await rowsFor(tenantId);
  await makeEligible(tenantId, submitted.id);
  await drainEtaSubmissions({ provider, reconcile: false, emailProvider: opts.emailProvider });
  return submitted.id;
}

describe("drainEtaSubmissions — the customer's fiscal-document email", () => {
  it("emails the customer on acceptance and stamps the row", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId, "POS-ONLINE");
    await placeWebOrderWithEmail(s.tenantId, s.branchId, s.productId, "buyer@example.test");

    const emailProvider = new FakeEmailProvider();
    await driveToAccepted(s.tenantId, { emailProvider });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("accepted");
    expect(row.customerEmailedAt).not.toBeNull();
    expect(row.customerEmailError).toBeNull();

    expect(emailProvider.sent).toHaveLength(1);
    expect(emailProvider.sent[0].to).toBe("buyer@example.test");
    // A RECEIPT, so the QR's portal link is the delivery — and it is the row's
    // own stored payload, not one rebuilt here.
    expect(emailProvider.sent[0].html).toContain(row.qrPayload!);
    expect(emailProvider.sent[0].subject).toContain("tax receipt");
  });

  it("sends NOTHING for an order with no address, and leaves both columns null", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId, "POS-ONLINE");
    await placeWebOrderWithEmail(s.tenantId, s.branchId, s.productId, null);

    const emailProvider = new FakeEmailProvider();
    await driveToAccepted(s.tenantId, { emailProvider });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("accepted");
    // TWO NULLS IS THE THIRD STATE — the dashboard's em-dash. Not a failure,
    // and deliberately not distinguishable from "we never tried" by a marker
    // column, because there is nothing for an owner to do about it.
    expect(row.customerEmailedAt).toBeNull();
    expect(row.customerEmailError).toBeNull();
    expect(emailProvider.sent).toHaveLength(0);
  });

  it("does not re-send when an accepted row is driven through persistAccepted again", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId, "POS-ONLINE");
    await placeWebOrderWithEmail(s.tenantId, s.branchId, s.productId, "buyer@example.test");

    const emailProvider = new FakeEmailProvider();
    const submissionId = await driveToAccepted(s.tenantId, { emailProvider });
    expect(emailProvider.sent).toHaveLength(1);
    const [afterFirst] = await rowsFor(s.tenantId);
    const stampedAt = afterFirst.customerEmailedAt;

    // THE RACE THIS GUARDS, reproduced rather than described: the claim lease
    // can expire while a poll is in flight, so a second drain can claim the
    // same row and reach `persistAccepted` for a document that is already
    // accepted. Putting the row back to `submitted` and re-polling it is
    // exactly that shape — one document, two trips through the accept path.
    await withTenant(s.tenantId, (tx) => tx.update(etaSubmissions)
      .set({ status: "submitted", nextAttemptAt: new Date(Date.now() - 1000) })
      .where(and(eq(etaSubmissions.tenantId, s.tenantId), eq(etaSubmissions.id, submissionId))));

    const second = new FakeEta([], [pollValid("LONG-MAIL")]);
    await drainEtaSubmissions({ provider: second, reconcile: false, emailProvider });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("accepted");
    // One email, and the original timestamp untouched — the guard skipped the
    // send rather than sending and re-stamping.
    expect(emailProvider.sent).toHaveLength(1);
    expect(row.customerEmailedAt?.getTime()).toBe(stampedAt?.getTime());
  });

  it("records a failed send WITHOUT disturbing the acceptance", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId, "POS-ONLINE");
    await placeWebOrderWithEmail(s.tenantId, s.branchId, s.productId, "buyer@example.test");

    const emailProvider = new FakeEmailProvider();
    emailProvider.failNext = new Error("Resend send failed: 503");
    await driveToAccepted(s.tenantId, { emailProvider });

    const [row] = await rowsFor(s.tenantId);
    // THE POINT OF THE WHOLE TASK: the fiscal facts are untouched. The document
    // is filed, ETA has named it, the audit event stands — a courtesy email
    // that did not go out may not look like a tax document that did not.
    expect(row.status).toBe("accepted");
    expect(row.acceptedAt).not.toBeNull();
    expect(row.etaLongId).toBe("LONG-MAIL");
    expect(row.lastError).toBeNull();
    // …and the failure is VISIBLE rather than lost: this column is what the
    // dashboard's submissions table renders as a "failed" marker.
    expect(row.customerEmailedAt).toBeNull();
    expect(row.customerEmailError).toContain("Resend send failed: 503");
    // The audits are exactly the two a clean acceptance writes — no email
    // failure leaked into the fiscal audit trail.
    const audits = await auditsFor(s.tenantId);
    expect(audits.map((a) => a.action).sort()).toEqual(["eta.submission.accepted", "eta.submission.submitted"]);
  });

  it("emails a B2B buyer their tax invoice — long id, no QR, same hook", async () => {
    const s = await seedSale();
    await withTenant(s.tenantId, (tx) => tx.update(orders)
      .set({ customerEmail: "finance@buyer.test" })
      .where(eq(orders.tenantId, s.tenantId)));
    // Supersede the sale's own receipt so the invoice is the live document, the
    // one sanctioned family switch (`requestB2bInvoice`'s shape).
    await withTenant(s.tenantId, (tx) => tx.update(etaSubmissions)
      .set({ status: "rejected" })
      .where(eq(etaSubmissions.tenantId, s.tenantId)));
    const [order] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.tenantId, s.tenantId)));
    await enqueueInvoice(s.tenantId, order.id);

    const emailProvider = new FakeEmailProvider();
    const provider = new FakeEta([accepted202("sub-inv-mail")], [pollValid("EG-LONG-9")]);
    await drainEtaSubmissions({ provider, reconcile: false, emailProvider });
    const [invoiceRow] = await invoiceRowsFor(s.tenantId);
    await makeEligible(s.tenantId, invoiceRow.id);
    await drainEtaSubmissions({ provider, reconcile: false, emailProvider });

    const [row] = await invoiceRowsFor(s.tenantId);
    expect(row.status).toBe("accepted");
    expect(row.customerEmailedAt).not.toBeNull();

    expect(emailProvider.sent).toHaveLength(1);
    expect(emailProvider.sent[0].to).toBe("finance@buyer.test");
    expect(emailProvider.sent[0].subject).toContain("tax invoice");
    expect(emailProvider.sent[0].html).toContain("EG-LONG-9");
    // BOTH FAMILIES REACH THE HOOK, and the invoice's mail links nowhere —
    // the non-vacuity twin of the receipt case at the top of this describe.
    expect(emailProvider.sent[0].html).not.toContain("href=");
  });
});

// ---------------------------------------------------------------------------
// THE LATE WINDOW (round 2 Task 8)
//
// ETA gives a receipt 24 hours from issuance and, past that, offers a Late
// Submission Request rather than a refusal. So the worker's job past the window
// is unchanged — submit — plus exactly one thing: tell the owner, once.
// ---------------------------------------------------------------------------

/** Backdates the row's clock so it is past ETA's window on the next claim. The
 *  worker reads `created_at`, so that is what moves — not `placed_at`, which is
 *  a different clock and the subject of its own test at the end of this block. */
function ageBeyondWindow(tenantId: string) {
  return withTenant(tenantId, (tx) => tx.update(etaSubmissions)
    .set({
      createdAt: new Date(Date.now() - SUBMISSION_WINDOW_MS - 60_000),
      nextAttemptAt: new Date(Date.now() - 1000),
    })
    .where(eq(etaSubmissions.tenantId, tenantId)));
}

/** Only the late-window alerts. The tenant's other fiscal notifications (a
 *  rejection, an exhausted retry ladder) share the type and severity, so
 *  counting them all would make "once" unfalsifiable. */
const lateNotificationsFor = async (tenantId: string) =>
  (await notificationsFor(tenantId)).filter((n) => n.title.includes("24-hour window"));

describe("drainEtaSubmissions — the late window", () => {
  it("STILL SUBMITS a document past the window, and charges it no attempt for being late", async () => {
    const s = await seedSale();
    await ageBeyondWindow(s.tenantId);
    const provider = new FakeEta([accepted202("sub-late")]);

    await drainEtaSubmissions({ provider, reconcile: false });

    // THE LOAD-BEARING ASSERTION OF THE WHOLE TASK. ETA's remedy for a stale
    // document is a Late Submission Request, not a refusal, so a worker that
    // stopped here would turn a late document into NO document — strictly worse,
    // and on our own authority rather than ETA's.
    expect(provider.submitted).toHaveLength(1);
    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("submitted");
    // Noticing a date is not an attempt at anything. Charging one would park a
    // document for a human sooner BECAUSE it was late — punishing the row for
    // the condition being reported.
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it("tells the owner once, naming the Late Submission Request and saying it kept trying", async () => {
    const s = await seedSale();
    await ageBeyondWindow(s.tenantId);

    await drainEtaSubmissions({ provider: new FakeEta([accepted202("sub-late-1")]), reconcile: false });

    const [alert] = await lateNotificationsFor(s.tenantId);
    expect(alert.body).toContain("past the 24h window");
    expect(alert.body).toContain("Late Submission Request");
    // The owner must not read this as "ServeOS gave up": the one action left is
    // theirs, at ETA's portal, and it is not a thing this dashboard can do.
    expect(alert.body).toContain("keeps trying");
    const [row] = await rowsFor(s.tenantId);
    expect(row.lateNotifiedAt).not.toBeNull();
  });

  it("flags a late row exactly ONCE across racing and repeated drains — the CAS pin", async () => {
    const s = await seedSale();
    await ageBeyondWindow(s.tenantId);

    // HALF ONE: two drains in flight together. This catches losing claim
    // exclusivity, but on its own it would pass even without the compare-and-set
    // — the claim's row locks serialize the two passes anyway.
    const provider = new FakeEta([accepted202("sub-race-late-a"), accepted202("sub-race-late-b")]);
    await Promise.all([
      drainEtaSubmissions({ provider, reconcile: false }),
      drainEtaSubmissions({ provider, reconcile: false }),
    ]);

    const [afterRace] = await rowsFor(s.tenantId);
    const firstFlaggedAt = afterRace.lateNotifiedAt;
    expect(firstFlaggedAt).not.toBeNull();
    expect(await lateNotificationsFor(s.tenantId)).toHaveLength(1);

    // HALF TWO — THE ONE THE CAS IS ACTUALLY FOR. A claim lease can expire while
    // a row is in flight, so the SAME row is legitimately claimed again on a
    // later pass, still past the window; putting it back in the eligible set is
    // exactly what an expired lease does. Without `late_notified_at IS NULL` in
    // the UPDATE's WHERE clause, every subsequent pass over an old row would
    // send the owner the same critical alert again — once per drain, forever,
    // for one document.
    await ageBeyondWindow(s.tenantId);
    await drainEtaSubmissions({ provider, reconcile: false });
    await ageBeyondWindow(s.tenantId);
    await drainEtaSubmissions({ provider, reconcile: false });

    expect(await lateNotificationsFor(s.tenantId)).toHaveLength(1);
    // And the write did not merely stay quiet — it did not happen at all. A
    // rewritten timestamp would make "when did this go late" unanswerable.
    const [afterRedrains] = await rowsFor(s.tenantId);
    expect(afterRedrains.lateNotifiedAt).toEqual(firstFlaggedAt);
  });

  it("never flags an e_invoice — no ETA page publishes an invoice deadline (VERIFY-13)", async () => {
    const s = await ringB2bSale();
    await ageBeyondWindow(s.tenantId);

    await drainEtaSubmissions({ provider: new FakeEta([accepted202("sub-b2b-old")]), reconcile: false });

    const [row] = await invoiceRowsFor(s.tenantId);
    // Submitted exactly as an in-window invoice would be — the scoping decides
    // who gets ALERTED, never what gets filed.
    expect(row.status).toBe("submitted");
    expect(row.lateNotifiedAt).toBeNull();
    expect(await lateNotificationsFor(s.tenantId)).toHaveLength(0);
    // And the dashboard says nothing rather than claiming it beat a deadline.
    const view = await getSubmissionById(s.tenantId, row.id);
    expect(view!.sideEffects.late).toEqual({ kind: "not-applicable" });
  });

  it("surfaces the flag on the dashboard as `late`, distinct from the derived `overdue`", async () => {
    const s = await seedSale();
    await ageBeyondWindow(s.tenantId);
    await drainEtaSubmissions({ provider: new FakeEta([accepted202("sub-late-view")]), reconcile: false });

    const { rows: [view] } = await listSubmissions(s.tenantId);
    // BOTH, and they are not the same statement: `overdue` is the live clock
    // condition (past the window, still not accepted), `late` is the historical
    // fact that the pipeline caught it and told someone.
    expect(view.overdue).toBe(true);
    expect(view.sideEffects.late.kind).toBe("late");

    // THE DIVERGENCE THAT PROVES THEY ARE DIFFERENT FACTS. Accept the document
    // and `overdue` goes false — the condition has stopped being true — while
    // `late` stands, because a Late Submission Request is owed for a document
    // that WAS late whether or not ETA eventually took it. One boolean could not
    // have carried both, and the half it would have dropped is the one an owner
    // still has to act on.
    await withTenant(s.tenantId, (tx) => tx.update(etaSubmissions)
      .set({ status: "accepted", acceptedAt: new Date() }).where(eq(etaSubmissions.tenantId, s.tenantId)));

    const { rows: [accepted] } = await listSubmissions(s.tenantId);
    expect(accepted.overdue).toBe(false);
    expect(accepted.sideEffects.late.kind).toBe("late");
  });

  it("A SWEPT ORDER'S ROW READS ON-TIME FOR ITS FIRST WINDOW — the clock-origin caveat, pinned", async () => {
    // The documented cost of deriving lateness from `created_at` rather than from
    // the document's own `dateTimeIssued`. An online order is fiscalised by the
    // reconciliation sweep, so a sale placed SIX DAYS ago gets its row written
    // today — and reads on-time for the next 24 hours even though ETA's clock
    // started six days back. Bounded by the sweep horizon (7 days), accepted
    // rather than fixed, and pinned here so it is a known property with a test
    // naming it rather than a surprise found on a dashboard.
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
    const orderId = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 6 * 24 * 60 });

    await drainEtaSubmissions({ provider: new FakeEta([accepted202("sub-swept-old")]), limit: 10 });

    const [row] = await rowsFor(s.tenantId);
    expect(row.orderId).toBe(orderId);
    // The row was written now, so neither derivation fires: not flagged, not
    // overdue. The FIX, if this is ever worth making, is to read `dateTimeIssued`
    // out of `request_json` — and the reason it has not been is that a document
    // nothing filed for six days has a larger problem than the timing of its chip.
    expect(row.lateNotifiedAt).toBeNull();
    const { rows: [view] } = await listSubmissions(s.tenantId);
    expect(view.overdue).toBe(false);
    expect(view.sideEffects.late).toEqual({ kind: "on-time" });
    expect(await lateNotificationsFor(s.tenantId)).toHaveLength(0);
  });
});
