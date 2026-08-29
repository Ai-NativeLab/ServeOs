import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { placeOrder } from "./service";
import { InvalidPhoneError } from "./errors";
import { isValidCustomerPhone } from "@/lib/phone";

async function seedTenant(slug: string, country: "EG" | "SA" = "EG") {
  const [t] = await db.insert(tenants).values({
    slug, name: `${country} Store`, country, vertical: "restaurant",
  }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
  const prod = await createProduct(t.id, { nameEn: "Pizza", nameAr: "بيتزا", basePrice: "100.00", categoryId: cat.id });
  await updateProduct(t.id, prod.id, { isPublished: true });

  return { tenant: t, branch, prod };
}

describe("Customer phone validation (Issue #173)", () => {
  describe("isValidCustomerPhone unit tests", () => {
    it("validates Egyptian mobile numbers correctly", () => {
      expect(isValidCustomerPhone("01012345678", "EG")).toBe(true);
      expect(isValidCustomerPhone("01198765432", "EG")).toBe(true);
      expect(isValidCustomerPhone("01234567890", "EG")).toBe(true);
      expect(isValidCustomerPhone("01555555555", "EG")).toBe(true);
      expect(isValidCustomerPhone("+201012345678", "EG")).toBe(true);
      expect(isValidCustomerPhone("00201112345678", "EG")).toBe(true);
      expect(isValidCustomerPhone("201212345678", "EG")).toBe(false); // bare country-code w/o + is not dialable
      expect(isValidCustomerPhone("1012345678", "EG")).toBe(false); // bare subscriber number w/o leading 0 (#187 review)

      // Invalids for Egypt
      expect(isValidCustomerPhone("123", "EG")).toBe(false);
      expect(isValidCustomerPhone("01312345678", "EG")).toBe(false); // 013 is Qalyubia landline
      expect(isValidCustomerPhone("0212345678", "EG")).toBe(false);  // 02 is Cairo landline
      expect(isValidCustomerPhone("0101234567", "EG")).toBe(false);   // 10 digits
      expect(isValidCustomerPhone("010123456789", "EG")).toBe(false); // 12 digits
      expect(isValidCustomerPhone("0512345678", "EG")).toBe(false);   // SA number on EG
      expect(isValidCustomerPhone("letters", "EG")).toBe(false);
    });

    // #187 review: real-world formatting must not reject a correct number —
    // an Arabic-first storefront routinely produces these.
    it("normalises punctuation, grouping and Arabic-Indic digits before testing", () => {
      expect(isValidCustomerPhone("(010) 1234-5678", "EG")).toBe(true);
      expect(isValidCustomerPhone("010.1234.5678", "EG")).toBe(true);
      expect(isValidCustomerPhone("+20 100 123 4567", "EG")).toBe(true);
      // The "+" must survive a leading parenthesis (#187 follow-up): stripping
      // it here left a bare country-code form the tightened regex refuses.
      expect(isValidCustomerPhone("(+20) 100 123 4567", "EG")).toBe(true);
      expect(isValidCustomerPhone("(+966) 51 234 5678", "SA")).toBe(true);
      expect(isValidCustomerPhone("\u0660\u0661\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668", "EG")).toBe(true); // ٠١٠١٢٣٤٥٦٧٨
      expect(isValidCustomerPhone("\u200e01012345678", "EG")).toBe(true); // LRM paste artefact
      expect(isValidCustomerPhone("010\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668", "EG")).toBe(true); // 010 followed by ١٢٣٤٥٦٧٨
    });

    it("validates Saudi mobile numbers correctly", () => {
      expect(isValidCustomerPhone("0512345678", "SA")).toBe(true);
      expect(isValidCustomerPhone("0598765432", "SA")).toBe(true);
      expect(isValidCustomerPhone("+966512345678", "SA")).toBe(true);
      expect(isValidCustomerPhone("00966598765432", "SA")).toBe(true);
      expect(isValidCustomerPhone("966512345678", "SA")).toBe(false); // same rule for SA

      // Invalids for Saudi
      expect(isValidCustomerPhone("123", "SA")).toBe(false);
      expect(isValidCustomerPhone("0112345678", "SA")).toBe(false); // 011 is Riyadh landline
      expect(isValidCustomerPhone("051234567", "SA")).toBe(false);  // 9 digits
      expect(isValidCustomerPhone("05123456789", "SA")).toBe(false);// 11 digits
      expect(isValidCustomerPhone("01012345678", "SA")).toBe(false);// EG number on SA
    });

    // F1 (#173 review): the walk-in sentinel is a POS-only escape hatch. The
    // shared default must REJECT it — a storefront/WhatsApp customer submitting
    // all-zeros is exactly the unreachable order this ticket closes.
    it("rejects the POS walk-in sentinel by default (storefront must not dodge the rule)", () => {
      expect(isValidCustomerPhone("000000000", "EG")).toBe(false);
      expect(isValidCustomerPhone("000000000", "SA")).toBe(false);
    });

    it("accepts the sentinel only via the explicit POS walk-in opt-in", () => {
      expect(isValidCustomerPhone("000000000", "EG", { allowWalkInSentinel: true })).toBe(true);
      expect(isValidCustomerPhone("000000000", "SA", { allowWalkInSentinel: true })).toBe(true);
      // The opt-in covers ONLY the sentinel, not other junk.
      expect(isValidCustomerPhone("123", "EG", { allowWalkInSentinel: true })).toBe(false);
    });
  });

  describe("placeOrder server-side phone gate", () => {
    it("rejects invalid phone for Egyptian tenant with InvalidPhoneError", async () => {
      const { tenant, branch, prod } = await seedTenant("phone-eg-1", "EG");

      await expect(
        placeOrder(tenant.id, {
          branchId: branch.id,
          fulfillmentType: "pickup",
          customerName: "Ahmed",
          customerPhone: "123",
          lines: [{ productId: prod.id, quantity: 1, selectedOptionIds: [] }],
        })
      ).rejects.toThrow(InvalidPhoneError);
    });

    it("accepts valid phone for Egyptian tenant", async () => {
      const { tenant, branch, prod } = await seedTenant("phone-eg-2", "EG");

      const res = await placeOrder(tenant.id, {
        branchId: branch.id,
        fulfillmentType: "pickup",
        customerName: "Ahmed",
        customerPhone: "01012345678",
        lines: [{ productId: prod.id, quantity: 1, selectedOptionIds: [] }],
      });

      expect(res.orderNumber).toBeDefined();
    });

    it("rejects invalid phone for Saudi tenant with InvalidPhoneError", async () => {
      const { tenant, branch, prod } = await seedTenant("phone-sa-1", "SA");

      await expect(
        placeOrder(tenant.id, {
          branchId: branch.id,
          fulfillmentType: "pickup",
          customerName: "Salem",
          customerPhone: "01012345678", // EG number on SA tenant
          lines: [{ productId: prod.id, quantity: 1, selectedOptionIds: [] }],
        })
      ).rejects.toThrow(InvalidPhoneError);
    });

    it("accepts valid phone for Saudi tenant", async () => {
      const { tenant, branch, prod } = await seedTenant("phone-sa-2", "SA");

      const res = await placeOrder(tenant.id, {
        branchId: branch.id,
        fulfillmentType: "pickup",
        customerName: "Salem",
        customerPhone: "0512345678",
        lines: [{ productId: prod.id, quantity: 1, selectedOptionIds: [] }],
      });

      expect(res.orderNumber).toBeDefined();
    });
  });
});
