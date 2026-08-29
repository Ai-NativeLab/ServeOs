import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { upsertOfflineMethod } from "./methods";
import { validatePayToDetail } from "./validation";
import { InvalidPayToDetailError } from "./errors";

async function seedTenant(slug: string, country: "EG" | "SA" = "EG") {
  const [t] = await db.insert(tenants).values({
    slug, name: `${country} Pay Test`, country, vertical: "restaurant",
  }).returning();
  return t;
}

describe("Offline payment method pay-to detail validation (Issue #174)", () => {
  describe("validatePayToDetail helper", () => {
    it("validates vodafone_cash format strictly (010XXXXXXXX, 11 digits)", () => {
      expect(validatePayToDetail("vodafone_cash", "01012345678", "EG")).toBe(true);
      expect(validatePayToDetail("vodafone_cash", "01098765432", "EG")).toBe(true);
      // Same normalisation as mobile_wallet (#187 review): formatted input is
      // the same number, not a different one.
      expect(validatePayToDetail("vodafone_cash", "010 1234 5678", "EG")).toBe(true);
      expect(validatePayToDetail("vodafone_cash", "010-1234-5678", "EG")).toBe(true);
      expect(validatePayToDetail("vodafone_cash", "+201012345678", "EG")).toBe(true);

      // Invalids
      expect(validatePayToDetail("vodafone_cash", "01112345678", "EG")).toBe(false); // 011 is Etisalat
      expect(validatePayToDetail("vodafone_cash", "01212345678", "EG")).toBe(false); // 012 is Orange
      expect(validatePayToDetail("vodafone_cash", "01512345678", "EG")).toBe(false); // 015 is WE
      expect(validatePayToDetail("vodafone_cash", "0101234567", "EG")).toBe(false);  // 10 digits
      expect(validatePayToDetail("vodafone_cash", "010123456789", "EG")).toBe(false);// 12 digits
      expect(validatePayToDetail("vodafone_cash", null, "EG")).toBe(false);
      expect(validatePayToDetail("vodafone_cash", "", "EG")).toBe(false);
      expect(validatePayToDetail("vodafone_cash", "free text notes", "EG")).toBe(false);
    });

    it("validates mobile_wallet format for the tenant country", () => {
      expect(validatePayToDetail("mobile_wallet", "01012345678", "EG")).toBe(true);
      expect(validatePayToDetail("mobile_wallet", "01112345678", "EG")).toBe(true);
      expect(validatePayToDetail("mobile_wallet", "01212345678", "EG")).toBe(true);
      expect(validatePayToDetail("mobile_wallet", "01512345678", "EG")).toBe(true);

      expect(validatePayToDetail("mobile_wallet", "0512345678", "SA")).toBe(true);
      expect(validatePayToDetail("mobile_wallet", "01012345678", "SA")).toBe(false);

      expect(validatePayToDetail("mobile_wallet", null, "EG")).toBe(false);
      expect(validatePayToDetail("mobile_wallet", "123", "EG")).toBe(false);
    });

    it("validates instapay address format", () => {
      expect(validatePayToDetail("instapay", "username@instapay", "EG")).toBe(true);
      expect(validatePayToDetail("instapay", "store.roma@ipa", "EG")).toBe(true);
      expect(validatePayToDetail("instapay", "01012345678", "EG")).toBe(true);

      expect(validatePayToDetail("instapay", null, "EG")).toBe(false);
      expect(validatePayToDetail("instapay", "", "EG")).toBe(false);
      expect(validatePayToDetail("instapay", "invalid address with spaces", "EG")).toBe(false);
    });

    it("allows cash without payToDetail", () => {
      expect(validatePayToDetail("cash", null, "EG")).toBe(true);
      expect(validatePayToDetail("cash", "", "EG")).toBe(true);
      expect(validatePayToDetail("cash", undefined, "EG")).toBe(true);
    });
  });

  describe("upsertOfflineMethod service validation", () => {
    it("rejects invalid vodafone_cash detail with InvalidPayToDetailError", async () => {
      const tenant = await seedTenant("pm-val-1", "EG");

      await expect(
        upsertOfflineMethod(tenant.id, {
          type: "vodafone_cash",
          label: "Vodafone Cash",
          payToDetail: "01112345678", // Etisalat prefix
        })
      ).rejects.toThrow(InvalidPayToDetailError);
    });

    it("saves valid vodafone_cash detail", async () => {
      const tenant = await seedTenant("pm-val-2", "EG");

      const row = await upsertOfflineMethod(tenant.id, {
        type: "vodafone_cash",
        label: "Vodafone Cash",
        payToDetail: "01012345678",
      });

      expect(row.payToDetail).toBe("01012345678");
    });

    it("rejects invalid instapay address with InvalidPayToDetailError", async () => {
      const tenant = await seedTenant("pm-val-3", "EG");

      await expect(
        upsertOfflineMethod(tenant.id, {
          type: "instapay",
          label: "InstaPay",
          payToDetail: "not an instapay handle",
        })
      ).rejects.toThrow(InvalidPayToDetailError);
    });
  });
});
