/**
 * Reports — and optionally repairs — whether a platform admin actually holds
 * `super_admin`.
 *
 *   npm run admin:check                                       # .env.local, read-only
 *   ENV_FILE=.env.production npm run admin:check              # audit production
 *   ENV_FILE=.env.production npm run admin:check -- --fix     # grant the role
 *   ENV_FILE=.env.production npm run admin:check -- --rotate  # new random password
 *   ... -- --email someone@else.com                           # non-default account
 *
 * Without --fix or --rotate nothing is written. An admin who can authenticate
 * but holds no role authenticates fine and then fails every authorization
 * check, which surfaces as a bounce straight back to the login form.
 *
 * --rotate prints the new password ONCE and stores only its hash. There is no
 * way to recover it afterwards; capture it before closing the terminal.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

const args = process.argv.slice(2);
const FIX = args.includes("--fix");
const ROTATE = args.includes("--rotate");

/** URL-safe, ~192 bits. Avoids characters that get mangled when pasted. */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}
const emailFlag = args.indexOf("--email");
if (emailFlag !== -1 && !args[emailFlag + 1]) {
  console.error("--email needs a value, e.g. --email admin@serveos.com");
  process.exit(1);
}
const EMAIL = emailFlag !== -1 ? args[emailFlag + 1] : "admin@serveos.com";

async function main() {
  const { and, eq, isNull } = await import("drizzle-orm");
  const { db, pool } = await import("../src/db/client");
  const { users } = await import("../src/server/auth/schema");
  const { loadUserRoleKeys } = await import("../src/server/auth/current-user");
  const { ensurePlatformSuperAdmin } = await import("../src/server/auth/platform-admin");

  const env = process.env.ENV_FILE ?? ".env.local";
  console.log(`${env} — platform admin: ${EMAIL}`);

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, EMAIL), isNull(users.tenantId)))
    .limit(1);

  if (!user) {
    console.log(`  ✗ no platform user with that email (tenant_id IS NULL)`);
    console.log(`    → the login form will reject it outright. Seed the environment.`);
    await pool.end();
    process.exit(1);
  }
  console.log(`  ✓ user exists (id ${user.id})`);
  console.log(`  ${user.passwordHash ? "✓" : "✗"} password hash ${user.passwordHash ? "present" : "MISSING — cannot sign in"}`);

  const before = await loadUserRoleKeys(user.id);
  const hasRole = before.includes("super_admin");
  console.log(`  ${hasRole ? "✓" : "✗"} roles: [${before.join(", ") || "none"}]`);

  if (ROTATE) {
    const { setPlatformAdminPassword, authenticatePlatformAdmin } = await import("../src/server/auth/admin-login");
    const password = generatePassword();
    await setPlatformAdminPassword(EMAIL, password);

    // Prove it before printing it — a rotation that silently failed would be
    // discovered at the worst possible moment.
    const check = await authenticatePlatformAdmin(EMAIL, password);
    if (!check.ok && check.reason === "invalid_credentials") {
      console.error("\n  ✗ rotation did not take — the new password does not authenticate.");
      await pool.end();
      process.exit(1);
    }

    console.log("\n  ✓ password rotated and verified.");
    console.log("\n  ┌─────────────────────────────────────────────────────────");
    console.log(`  │ ${EMAIL}`);
    console.log(`  │ ${password}`);
    console.log("  └─────────────────────────────────────────────────────────");
    console.log("\n  Shown once. Only the hash is stored — put it in your password manager now.");
    if (!check.ok) console.log(`  Note: account still lacks super_admin (${check.reason}) — re-run with --fix.`);
    await pool.end();
    return;
  }

  if (hasRole) {
    console.log("\nNothing to repair — this account is a working super admin.");
    await pool.end();
    return;
  }

  console.log("\n  → DIAGNOSIS: authenticates, but holds no super_admin role.");
  console.log("    Every /admin page throws Forbidden, so login appears to fail.");

  if (!FIX) {
    console.log("\nRe-run with --fix to grant super_admin. Nothing was written.");
    await pool.end();
    process.exit(1);
  }

  const res = await ensurePlatformSuperAdmin(EMAIL);
  const after = await loadUserRoleKeys(res.userId);
  console.log(`\n  ✓ repaired — role row ${res.roleCreated ? "created" : "reused"}, grant ${res.roleGranted ? "added" : "already present"}`);
  console.log(`  ✓ roles now: [${after.join(", ")}]`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
