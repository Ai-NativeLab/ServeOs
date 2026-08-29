import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { createPairingCode, redeemPairingCode } from "./service";
import { signInCashier } from "./cashier";
import { requirePosCashier, assertPermission } from "./require-cashier";
import { PosCashierError, PosForbiddenError } from "./errors";
import { sha256Hex } from "@/server/audit/canonical";

let n = 0;

/** Seeds a tenant + branch + a paired device + a signed-in cashier of the given role. */
async function seedDeviceAndCashier(roleKey: "owner" | "staff") {
  const i = n++;
  const [t] = await db.insert(tenants).values({
    status: "active", slug: `req-cashier-${i}`, name: "T", country: "EG", vertical: "restaurant",
  }).returning();
  const [branch] = await withTenant(t.id, (tx) =>
    tx.insert(branches).values({ tenantId: t.id, name: "Main" }).returning(),
  );
  const [user] = await db.insert(users).values({
    tenantId: t.id, name: "Cash Ier", email: `rc${i}@x.com`,
    passwordHash: await hashPassword("pw123456"), status: "active",
  }).returning();
  const [role] = await db.insert(roles).values({ tenantId: t.id, key: roleKey, name: roleKey }).returning();
  await db.insert(userRoles).values({ userId: user.id, roleId: role.id });

  const { code } = await createPairingCode(t.id, branch.id, "counter", user.id);
  const { deviceToken } = await redeemPairingCode(code);
  const { cashierToken } = await signInCashier(t.id, user.email!, "pw123456");

  return { tenantId: t.id, branchId: branch.id, userId: user.id, deviceToken, cashierToken };
}

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://x/api/pos/v1/sales", { headers });
}

describe("requirePosCashier", () => {
  it("resolves the context for a valid device + same-tenant cashier", async () => {
    const s = await seedDeviceAndCashier("owner");
    const ctx = await requirePosCashier(reqWith({
      Authorization: `Bearer ${s.deviceToken}`,
      "X-POS-Cashier": s.cashierToken,
    }));
    expect(ctx.cashierUserId).toBe(s.userId);
    expect(ctx.tenantId).toBe(s.tenantId);
    expect(ctx.branchId).toBe(s.branchId);
    expect(ctx.permissions).toContain("pos:sell");
  });

  it("rejects a cashier token from a different tenant than the device", async () => {
    // The security boundary: a cashier signed into tenant A must not be able to
    // ring sales on tenant B's paired device.
    const a = await seedDeviceAndCashier("owner");
    const b = await seedDeviceAndCashier("owner");
    await expect(
      requirePosCashier(reqWith({
        Authorization: `Bearer ${b.deviceToken}`,
        "X-POS-Cashier": a.cashierToken,
      })),
    ).rejects.toThrow(PosCashierError);
  });

  it("rejects when the X-POS-Cashier header is missing", async () => {
    const s = await seedDeviceAndCashier("owner");
    await expect(
      requirePosCashier(reqWith({ Authorization: `Bearer ${s.deviceToken}` })),
    ).rejects.toThrow(PosCashierError);
  });

  it("captures a fingerprint: hashed device token, device id, and app version", async () => {
    const s = await seedDeviceAndCashier("owner");

    // No X-POS-App-Version header → older POS build → appVersion null (still audits).
    const ctx = await requirePosCashier(reqWith({
      Authorization: `Bearer ${s.deviceToken}`,
      "X-POS-Cashier": s.cashierToken,
    }));
    // The raw device token is never stored — only its SHA-256, so a leaked audit
    // dump cannot be replayed to authenticate.
    expect(ctx.fingerprint.deviceTokenHash).toBe(sha256Hex(s.deviceToken));
    expect(ctx.fingerprint.deviceTokenHash).not.toBe(s.deviceToken);
    expect(ctx.fingerprint.deviceId).toBe(ctx.deviceId);
    expect(ctx.fingerprint.appVersion).toBeNull();

    // With the header present, the build version is recorded.
    const ctxWithVersion = await requirePosCashier(reqWith({
      Authorization: `Bearer ${s.deviceToken}`,
      "X-POS-Cashier": s.cashierToken,
      "X-POS-App-Version": "pos-9.9",
    }));
    expect(ctxWithVersion.fingerprint.appVersion).toBe("pos-9.9");
  });
});

describe("assertPermission", () => {
  it("throws for a staff cashier attempting a discount, but allows pos:sell", async () => {
    const s = await seedDeviceAndCashier("staff");
    const ctx = await requirePosCashier(reqWith({
      Authorization: `Bearer ${s.deviceToken}`,
      "X-POS-Cashier": s.cashierToken,
    }));
    expect(() => assertPermission(ctx, "pos:sell")).not.toThrow();
    expect(() => assertPermission(ctx, "pos:discount")).toThrow(PosForbiddenError);
  });
});
