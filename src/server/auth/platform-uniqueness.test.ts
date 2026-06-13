import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { users } from "./schema";

describe("platform super-admin uniqueness", () => {
  it("rejects two platform (null-tenant) users with the same email", async () => {
    await db.insert(users).values({ tenantId: null, name: "A", email: "dup@serveos.com" });
    await expect(
      db.insert(users).values({ tenantId: null, name: "B", email: "dup@serveos.com" }),
    ).rejects.toThrow();
  });
});
