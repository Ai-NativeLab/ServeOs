import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// Lazily create the connection so importing this module never requires
// DATABASE_URL. A Next.js production build collects page data for every route
// (which imports this module transitively); the build must not need database
// credentials. The connection is created on first actual use at runtime.
let _pool: Pool | undefined;
let _db: NodePgDatabase<typeof schema> | undefined;

function ensure(): { pool: Pool; db: NodePgDatabase<typeof schema> } {
  if (!_db || !_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set — check .env.local / .env.test");
    }
    _pool = new Pool({ connectionString });
    _db = drizzle(_pool, { schema });
  }
  return { pool: _pool, db: _db };
}

function lazy<T extends object>(pick: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const real = pick();
      const value = Reflect.get(real, prop, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
}

export const pool = lazy<Pool>(() => ensure().pool);
export const db = lazy<NodePgDatabase<typeof schema>>(() => ensure().db);
export type DB = NodePgDatabase<typeof schema>;
