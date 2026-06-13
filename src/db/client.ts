import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// DATABASE_URL is loaded from the correct env file per environment:
// dev/build → .env.local (Next.js), tests → .env.test (Vitest globalSetup/setup),
// scripts → whichever dotenv file the script loads. No string munging.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set — check .env.local / .env.test");
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export type DB = typeof db;
