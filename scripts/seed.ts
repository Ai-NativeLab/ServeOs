import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true });
import { eq } from "drizzle-orm";

async function main() {
  const { db, pool } = await import("../src/db/client");
  const { users, roles, userRoles } = await import("../src/server/auth/schema");
  const { tenants } = await import("../src/server/tenancy/schema");
  const { hashPassword } = await import("../src/server/auth/password");
  const { seedDefaultPlans } = await import("../src/server/subscription");
  const { registerRestaurant } = await import("../src/server/onboarding");
  const { approveTenant } = await import("../src/server/platform");

  await seedDefaultPlans();

  // Platform super-admin (idempotent by email existence)
  const adminEmail = "admin@serveos.com";
  let [admin] = await db.select().from(users).where(eq(users.email, adminEmail)).limit(1);
  if (!admin) {
    [admin] = await db
      .insert(users)
      .values({ tenantId: null, name: "Platform Admin", email: adminEmail, passwordHash: await hashPassword("admin1234") })
      .returning();
    const [role] = await db.insert(roles).values({ tenantId: null, key: "super_admin", name: "Super Admin" }).returning();
    await db.insert(userRoles).values({ userId: admin.id, roleId: role.id });
  }

  // Demo restaurant (idempotent by slug existence) — approved + live
  const demoSlug = "roma";
  const [existing] = await db.select().from(tenants).where(eq(tenants.slug, demoSlug)).limit(1);
  if (!existing) {
    const demo = await registerRestaurant({
      restaurantName: "Pizza Roma",
      slug: demoSlug,
      country: "EG",
      ownerName: "Sam Adel",
      email: "owner@roma.com",
      password: "owner1234",
    });
    await approveTenant(demo.tenantId, admin.id);
  }

  console.log("Seed complete: admin@serveos.com / admin1234, owner@roma.com / owner1234, storefront roma.serveos.localhost");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
