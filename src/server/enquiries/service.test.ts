import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { FakeEmailProvider } from "@/server/email/fake-provider";
import { planEnquiries } from "./schema";
import { createEnquiry, recentlyEnquired } from "./service";

const BASE = {
  planKey: "enterprise",
  name: "Ahmed Sabry",
  businessName: "El Nour Pharmacy",
  phone: "+201000000000",
  email: "ahmed@example.com",
  locale: "en" as const,
};

let provider: FakeEmailProvider;
let previousInbox: string | undefined;

beforeEach(async () => {
  previousInbox = process.env.SALES_INBOX_EMAIL;
  process.env.SALES_INBOX_EMAIL = "sales@serveos.tech";
  provider = new FakeEmailProvider();
  await db.delete(planEnquiries);
});

afterEach(() => {
  if (previousInbox === undefined) delete process.env.SALES_INBOX_EMAIL;
  else process.env.SALES_INBOX_EMAIL = previousInbox;
});

describe("createEnquiry", () => {
  it("records the lead and marks it sent", async () => {
    const res = await createEnquiry(BASE, provider);
    expect(res.emailed).toBe(true);

    const [row] = await db.select().from(planEnquiries).where(eq(planEnquiries.id, res.id));
    expect(row.planKey).toBe("enterprise");
    expect(row.businessName).toBe("El Nour Pharmacy");
    expect(row.status).toBe("sent");
    expect(row.sentAt).not.toBeNull();
  });

  it("names the plan in the subject and lets a reply reach the prospect", async () => {
    await createEnquiry(BASE, provider);
    const sent = provider.sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("sales@serveos.tech");
    expect(sent[0].replyTo).toBe("ahmed@example.com");
    expect(sent[0].subject).toContain("enterprise");
  });

  it("escapes the prospect's own text rather than rendering it", async () => {
    await createEnquiry({ ...BASE, businessName: "<script>alert(1)</script>" }, provider);
    expect(provider.sent[0].html).not.toContain("<script>");
    expect(provider.sent[0].html).toContain("&lt;script&gt;");
  });

  // The whole reason the row is written before the send is attempted: a lead
  // must survive a missing key, an unverified domain or a provider outage.
  it("keeps the lead when there is nowhere to send it", async () => {
    delete process.env.SALES_INBOX_EMAIL;
    const res = await createEnquiry(BASE, provider);
    expect(res.emailed).toBe(false);

    const [row] = await db.select().from(planEnquiries).where(eq(planEnquiries.id, res.id));
    expect(row).toBeTruthy();
    expect(row.status).toBe("unsent");
    expect(row.lastError).toContain("SALES_INBOX_EMAIL");
  });
});

describe("recentlyEnquired", () => {
  it("is false for an address that has never enquired", async () => {
    expect(await recentlyEnquired("nobody@example.com")).toBe(false);
  });

  it("is true straight after an enquiry, so the form can throttle", async () => {
    await createEnquiry(BASE, provider);
    expect(await recentlyEnquired(BASE.email)).toBe(true);
  });

  it("only throttles the address that enquired", async () => {
    await createEnquiry(BASE, provider);
    expect(await recentlyEnquired("someone.else@example.com")).toBe(false);
  });
});
