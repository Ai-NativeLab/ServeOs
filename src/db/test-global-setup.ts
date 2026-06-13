import { config } from "dotenv";
config({ path: ".env.test", override: true });
import { existsSync } from "node:fs";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export default async function () {
  if (!existsSync("./drizzle/meta/_journal.json")) return;
  const { db, pool } = await import("./client");
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
}
