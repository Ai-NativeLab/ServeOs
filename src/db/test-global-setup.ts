import { config } from "dotenv";
import { existsSync } from "node:fs";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: ".env.test", override: true });

export default async function () {
  if (!existsSync("./drizzle/meta/_journal.json")) return;
  // Dynamic import is intentional: static imports are hoisted before the dotenv
  // config() call above, which would make client.ts throw on its DATABASE_URL check.
  const { db, pool } = await import("./client");
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
}
