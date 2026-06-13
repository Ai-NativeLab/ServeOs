import { config } from "dotenv";
config({ path: ".env.test", override: true });
import { beforeEach } from "vitest";

beforeEach(async () => {
  const { truncateAll } = await import("./test-harness");
  await truncateAll();
});
