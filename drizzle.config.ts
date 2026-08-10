import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
