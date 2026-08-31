import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { orders } from "@/server/ordering/schema";
import { users, type User } from "@/server/auth/schema";
import { auditEvents } from "@/server/audit/schema";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { etaSubmissions } from "@/server/fiscal/schema";
import type { RoleKey } from "@/server/rbac/permissions";

/**
 * Route-level tests for the fiscal dashboard API, following the house pattern
 * (`api/purchase-orders/[id]/receipts/route.test.ts`): mock the ONE seam that
 * needs a live HTTP request — the session — and leave everything below it real,
 * so the permission check, the config service, RLS and the audit chain are all
 * exercised for real rather than stubbed into agreement.
 *
 * `requireDashboardUser` is what is faked, NOT `resolveFiscalContext`: the whole
 * point of these tests is that the real `authorize(roleKeys, "fiscal:manage")`
 * runs, so a manager really is refused rather than a mock saying so.
 *
 * `actionAudit` is faked because it reads `next/headers`, which only exists
 * inside a request scope; the actor it returns is a real `AuditActorInput`.
 */

vi.mock("@/server/auth/dashboard-context", () => ({ requireDashboardUser: vi.fn() }));

let actorUserId: string | null = null;
vi.mock("@/server/audit/action-context", () => ({
  actionAudit: vi.fn(async () => ({
    actorUserId,
    actorType: "user" as const,
    roleKey: "owner",
    fingerprint: emptyFingerprint(),
  })),
}));

import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { redactedCause } from "./fiscal-errors";
import { GET as getConfig, PUT as putConfig } from "./config/route";
import { POST as postResubmit } from "./submissions/[id]/resubmit/route";

const SECRET_REF = "env://ZZ_ROUTE_ETA_SECRET_SENTINEL";
const SIGNING_REF = "env://ZZ_ROUTE_ETA_SIGNING_SENTINEL";

let n = 0;

function signIn(tenantId: string, roleKeys: RoleKey[], userId: string) {
  actorUserId = userId;
  vi.mocked(requireDashboardUser).mockResolvedValue({ user: { id: userId } as User, tenantId, roleKeys });
}

async function seedTenant() {
  const [tenant] = await db
    .insert(tenants)
    .values({ slug: `fiscal-route-${n++}`, name: "Fiscal Co", country: "EG" })
    .returning();
  const [user] = await db
    .insert(users)
    .values({ tenantId: tenant.id, name: "Owner", email: `fiscal-route-${n++}@example.test` })
    .returning();
  return { tenantId: tenant.id, userId: user.id };
}

const validBody = () => ({
  rin: "200173707",
  clientId: "erp-client-id",
  clientSecretRef: SECRET_REF,
  signingKeyRef: SIGNING_REF,
  environment: "preprod",
  activationStatus: "pending",
  wireContext: {
    sellerName: "Fiscal Co",
    activityCode: "5610",
    branchCode: "0",
    branchAddress: {
      country: "EG",
      governate: "Cairo",
      regionCity: "Nasr City",
      street: "Test Street",
      buildingNumber: "12",
    },
  },
});

const putReq = (body: unknown) =>
  new NextRequest("http://localhost/api/dashboard/fiscal/config", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const post = () => new NextRequest("http://localhost/api/dashboard/fiscal/submissions/x/resubmit", { method: "POST" });

beforeEach(() => {
  vi.mocked(requireDashboardUser).mockReset();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET/PUT /api/dashboard/fiscal/config", () => {
  it("returns null before setup, then the MASKED config — never a reference", async () => {
    const { tenantId, userId } = await seedTenant();
    signIn(tenantId, ["owner"], userId);

    expect(await (await getConfig()).json()).toBeNull();

    const saved = await putConfig(putReq(validBody()));
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body).toMatchObject({ rin: "200173707", hasSecret: true, hasSigningKey: true });

    const read = await (await getConfig()).json();
    // The load-bearing assertion, over the SERIALIZED response: whatever fields
    // the view grows later, no reference may appear in the bytes sent to the
    // browser.
    for (const payload of [JSON.stringify(body), JSON.stringify(read)]) {
      expect(payload).not.toContain(SECRET_REF);
      expect(payload).not.toContain(SIGNING_REF);
    }
  });

  it("refuses a manager, a staff user and a pharmacist with 403 — fiscal:manage is owner-only", async () => {
    const { tenantId, userId } = await seedTenant();
    for (const role of ["manager", "staff", "pharmacist"] as const) {
      signIn(tenantId, [role], userId);
      expect((await getConfig()).status).toBe(403);
      expect((await putConfig(putReq(validBody()))).status).toBe(403);
    }
    // And the refusal is real: nothing was written.
    signIn(tenantId, ["owner"], userId);
    expect(await (await getConfig()).json()).toBeNull();
  });

  it("maps a validation failure to a 400 naming the field, not a 500", async () => {
    const { tenantId, userId } = await seedTenant();
    signIn(tenantId, ["owner"], userId);

    const res = await putConfig(putReq({ ...validBody(), rin: "12345" }));
    expect(res.status).toBe(400);
    expect((await res.json()).issues).toEqual([expect.objectContaining({ path: "rin" })]);

    const malformed = await putConfig(
      new NextRequest("http://localhost/api/dashboard/fiscal/config", {
        method: "PUT",
        body: "{not json",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(malformed.status).toBe(400);
  });
});

describe("redactedCause", () => {
  it("keeps the credential reference out of the log line a failed write would write", () => {
    // The shape Drizzle actually throws: the failing query's parameters — the
    // `*_ref` columns among them — inlined into the message. Logging that
    // verbatim writes the map to the secret store into the deployment's log
    // stream, where it outlives the request by weeks.
    const drizzleish = Object.assign(
      new Error(
        `Failed query: insert into "eta_tenant_config" (...) values (...)\nparams: t-1,200173707,${SECRET_REF},${SIGNING_REF}`,
      ),
      { name: "DrizzleQueryError", code: "23503", constraint: "eta_tenant_config_online_device_id_fk" },
    );

    const logged = JSON.stringify(redactedCause(drizzleish));
    expect(logged).not.toContain(SECRET_REF);
    expect(logged).not.toContain(SIGNING_REF);
    expect(logged).not.toContain("Failed query");
    // What survives is what actually identifies the fault.
    expect(redactedCause(drizzleish)).toEqual({
      errorName: "DrizzleQueryError",
      pgCode: "23503",
      pgConstraint: "eta_tenant_config_online_device_id_fk",
    });
    // A non-Error throw still produces something loggable rather than throwing
    // inside the error handler.
    expect(redactedCause("boom")).toEqual({ errorName: "string" });
    expect(redactedCause(null)).toEqual({ errorName: "object" });
  });
});

describe("POST /api/dashboard/fiscal/submissions/[id]/resubmit", () => {
  async function seedRejected(opts: { etaUuid?: string | null } = {}) {
    const { tenantId, userId } = await seedTenant();
    const [branch] = await withTenant(tenantId, (tx) =>
      tx.insert(branches).values({ tenantId, name: "Main" }).returning(),
    );
    const [order] = await withTenant(tenantId, (tx) =>
      tx.insert(orders).values({
        tenantId,
        branchId: branch.id,
        orderNumber: 1000 + n++,
        fulfillmentType: "pickup",
        customerName: "Walk-in",
        customerPhone: "+201000000000",
        subtotal: "100.00",
        vatRateSnapshot: "14",
        vatAmount: "14.00",
        total: "114.00",
        statusToken: `tok-route-${n++}`,
      }).returning(),
    );
    const [row] = await withTenant(tenantId, (tx) =>
      tx.insert(etaSubmissions).values({
        tenantId,
        docType: "e_receipt",
        orderId: order.id,
        status: "rejected",
        etaUuid: opts.etaUuid === undefined ? `uuid-${n++}` : opts.etaUuid,
        lastError: "InvalidTaxpayer",
      }).returning(),
    );
    return { tenantId, userId, orderId: order.id, submission: row };
  }

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("queues the correction AND emits the who-asked-for-it audit event", async () => {
    const { tenantId, userId, submission } = await seedRejected();
    signIn(tenantId, ["owner"], userId);

    const res = await postResubmit(post(), params(submission.id));
    expect(res.status).toBe(201);
    const { submissionId } = await res.json();
    expect(submissionId).not.toBe(submission.id);

    // The new row references the rejected document — ETA does not accept a fix
    // in place (addendum C3).
    const [correction] = await withTenant(tenantId, (tx) =>
      tx.select().from(etaSubmissions).where(eq(etaSubmissions.id, submissionId)),
    );
    expect(correction).toMatchObject({ status: "pending", referenceOldUuid: submission.etaUuid });

    // This event is Task 5's allowlist debt being paid: enqueueCorrectedResubmission
    // takes no actor, so this route is the only place that knows WHO decided the
    // rejection was understood.
    const events = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
    );
    const emitted = events.filter((e) => e.action === "eta.submission.resubmission_requested");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      entityType: "eta_submission",
      entityId: submissionId,
      actorType: "user",
      actorUserId: userId,
    });
    expect(emitted[0].metadata).toMatchObject({
      originalSubmissionId: submission.id,
      referenceOldUuid: submission.etaUuid,
    });
  });

  it("refuses a non-owner with 403 and queues nothing", async () => {
    const { tenantId, userId, submission } = await seedRejected();
    signIn(tenantId, ["manager"], userId);

    expect((await postResubmit(post(), params(submission.id))).status).toBe(403);

    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(etaSubmissions).where(eq(etaSubmissions.tenantId, tenantId)),
    );
    expect(rows).toHaveLength(1);
    const events = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
    );
    expect(events).toEqual([]);
  });

  it("404s an unknown id and 409s every precondition the enqueue refuses", async () => {
    const { tenantId, userId, submission } = await seedRejected();
    signIn(tenantId, ["owner"], userId);

    const missing = await postResubmit(post(), params("00000000-0000-4000-8000-000000000000"));
    expect(missing.status).toBe(404);

    // Already-queued correction: two live corrections would be two documents
    // ETA could both accept, declaring one sale twice.
    expect((await postResubmit(post(), params(submission.id))).status).toBe(201);
    expect((await postResubmit(post(), params(submission.id))).status).toBe(409);

    // Not rejected — a pending/submitted/accepted document is not superseded by
    // anything.
    const pending = await seedRejected();
    await withTenant(pending.tenantId, (tx) =>
      tx.update(etaSubmissions).set({ status: "pending" }).where(eq(etaSubmissions.id, pending.submission.id)),
    );
    signIn(pending.tenantId, ["owner"], pending.userId);
    expect((await postResubmit(post(), params(pending.submission.id))).status).toBe(409);

    // Rejected, but it never reached ETA — there is no uuid for a correction to
    // reference, so it is re-enqueued as an original instead.
    const noUuid = await seedRejected({ etaUuid: null });
    signIn(noUuid.tenantId, ["owner"], noUuid.userId);
    expect((await postResubmit(post(), params(noUuid.submission.id))).status).toBe(409);
  });
});
