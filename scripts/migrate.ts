import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true });

async function main() {
  // Dynamic import is intentional: static imports are hoisted before the dotenv
  // config() call above, which would make client.ts throw on its DATABASE_URL check.
  const { db, pool } = await import("../src/db/client");
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log("migrations applied");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
