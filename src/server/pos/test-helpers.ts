import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import { createPairingCode, redeemPairingCode, resolveDevice } from "./service";
import { signInCashier } from "./cashier";
import { openShift } from "./shifts";
import type { PosShift } from "./shift-schema";
import type { PosCashierContext } from "./require-cashier";
import type { VerticalId } from "@/server/verticals";

/**
 * Opens a drawer for a fixture. Cash cannot be taken without one, so any test
 * that rings a cash tender starts here.
 */
export function openShiftForCtx(ctx: PosCashierContext, openingFloat = 200): Promise<PosShift> {
  return openShift(ctx, { openingFloat });
}

let n = 0;

/**
 * A tenant with one branch, one published 100.00 product, a paired device, and
 * a signed-in cashier of the given role. `total` is the server's total for a
 * single unit — tests assert against it rather than hardcoding a number that
 * would drift with the tenant's VAT/service-charge defaults.
 *
 * `opts.vertical` defaults to restaurant (stockTracking off). A stock-tracking
 * vertical (retail/pharmacy/timber) plus a `trackStock` product is how a test
 * proves the refund-restock integer add-back actually moves stock.
 */
export async function seedPosContext(
  role: "owner" | "manager" | "staff" = "owner",
  opts: { vertical?: VerticalId; trackStock?: boolean; stockQuantity?: number | null } = {},
): Promise<{
  ctx: PosCashierContext;
  tenantId: string;
  branchId: string;
  productId: string;
  managerId: string;
  total: number;
}> {
  const i = n++;
  const vertical = opts.vertical ?? "restaurant";
  const [t] = await db.insert(tenants).values({
    slug: `pos-sale-${i}`, name: "T", country: "EG", vertical,
    // #164: the till refuses non-servable tenants — fixtures run a live store.
    status: "active",
  }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");

  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });

  const cat = await createCategory(t.id, { nameEn: "Pizza", nameAr: "بيتزا" });
  const prod = await createProduct(t.id, {
    nameEn: "Margherita", nameAr: "مارجريتا", basePrice: "100", categoryId: cat.id,
    trackStock: opts.trackStock ?? false, stockQuantity: opts.stockQuantity ?? null,
  });
  await updateProduct(t.id, prod.id, { isPublished: true });

  // The cashier under test.
  const [cashierUser] = await db.insert(users).values({
    tenantId: t.id, name: "Cash Ier", email: `cashier-${i}@x.com`,
    passwordHash: await hashPassword("pw123456"), status: "active",
  }).returning();
  const [cashierRole] = await db.insert(roles).values({ tenantId: t.id, key: role, name: role }).returning();
  await db.insert(userRoles).values({ userId: cashierUser.id, roleId: cashierRole.id });

  // A manager who can authorize what a staff cashier cannot.
  const [managerUser] = await db.insert(users).values({
    tenantId: t.id, name: "Man Ager", email: `manager-${i}@x.com`,
    passwordHash: await hashPassword("pw123456"), status: "active",
  }).returning();
  const [managerRole] = await db.insert(roles).values({ tenantId: t.id, key: "manager", name: "manager" }).returning();
  await db.insert(userRoles).values({ userId: managerUser.id, roleId: managerRole.id });

  const { code } = await createPairingCode(t.id, branch.id, "counter", managerUser.id);
  const { deviceToken } = await redeemPairingCode(code);
  const device = (await resolveDevice(deviceToken))!;

  const session = await signInCashier(t.id, cashierUser.email!, "pw123456");

  const pricing = await getCheckoutPricing(t.id);
  const total = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1 }], 0).total;

  return {
    ctx: {
      deviceId: device.deviceId,
      tenantId: t.id,
      branchId: branch.id,
      cashierUserId: cashierUser.id,
      cashierName: cashierUser.name,
      permissions: session.permissions,
      fingerprint: {
        deviceId: device.deviceId, deviceTokenHash: "test-token-hash",
        appVersion: "test-1.0.0", ip: "127.0.0.1", userAgent: "vitest",
      },
    },
    tenantId: t.id,
    branchId: branch.id,
    productId: prod.id,
    managerId: managerUser.id,
    total,
  };
}
