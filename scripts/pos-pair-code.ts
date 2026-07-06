/**
 * Mints a 24-hour POS pairing code for an existing tenant + its first branch.
 *
 *   SLUG=roma tsx scripts/pos-pair-code.ts              # against .env.local (prod)
 *   SLUG=roma ENV_FILE=.env.test tsx scripts/pos-pair-code.ts
 *
 * Requires the tenant, at least one branch, and one user to already exist,
 * and the pos_* tables to have been migrated.
 */
import { config } from "dotenv";
import { randomBytes } from "node:crypto";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true });

const SLUG = process.env.SLUG ?? "roma";
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function code8(): string {
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

async function main() {
  const { db, pool } = await import("../src/db/client");
  const { eq } = await import("drizzle-orm");
  const { tenants } = await import("../src/server/tenancy/schema");
  const { users } = await import("../src/server/auth/schema");
  const { posPairingCodes } = await import("../src/server/pos/schema");
  const { listBranches } = await import("../src/server/branches/service");

  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, SLUG)).limit(1);
  if (!tenant) throw new Error(`No tenant with slug "${SLUG}"`);

  const branches = await listBranches(tenant.id);
  if (branches.length === 0) throw new Error(`Tenant "${SLUG}" has no branches`);
  const branch = branches[0];

  const [user] = await db.select().from(users).where(eq(users.tenantId, tenant.id)).limit(1);
  if (!user) throw new Error(`Tenant "${SLUG}" has no users`);

  const code = code8();
  await db.insert(posPairingCodes).values({
    tenantId: tenant.id,
    branchId: branch.id,
    code,
    label: "Desktop POS",
    createdByUserId: user.id,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  console.log("\n────────────────────────────────────────");
  console.log(`  TENANT:        ${tenant.name} (${SLUG})`);
  console.log(`  BRANCH:        ${branch.name}`);
  console.log(`  PAIRING CODE:  ${code}`);
  console.log(`  valid for:     24 hours`);
  console.log("────────────────────────────────────────\n");

  await pool.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
