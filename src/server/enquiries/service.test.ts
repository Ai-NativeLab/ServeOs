import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { FakeEmailProvider } from "@/server/email/fake-provider";
import { planEnquiries } from "./schema";
import { createEnquiry, recentlyEnquired, tooManyFromIp, unsentEnquiries, IP_HOURLY_LIMIT } from "./service";

const BASE = {
  planKey: "enterprise",
  name: "Ahmed Sabry",
  businessName: "El Nour Pharmacy",
  phone: "+201000000000",
  email: "ahmed@example.com",
  locale: "en" as const,
  ip: "41.33.1.9",
};

let provider: FakeEmailProvider;
let previousInbox: string | undefined;

beforeEach(async () => {
  previousInbox = process.env.SALES_INBOX_EMAIL;
  process.env.SALES_INBOX_EMAIL = "sales@serveos.tech";
  provider = new FakeEmailProvider();
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

  // The other half of the same guarantee: the provider itself failing must not
  // cost the lead either. The design called for this case and it was untested.
  it("keeps the lead, and why, when the provider rejects the send", async () => {
    provider.failNext = new Error("domain is not verified");
    const res = await createEnquiry(BASE, provider);
    expect(res.emailed).toBe(false);

    const [row] = await db.select().from(planEnquiries).where(eq(planEnquiries.id, res.id));
    expect(row.status).toBe("unsent");
    expect(row.lastError).toContain("domain is not verified");
    expect(row.sentAt).toBeNull();
  });

  it("records the submitting address so it can be capped", async () => {
    const res = await createEnquiry(BASE, provider);
    const [row] = await db.select().from(planEnquiries).where(eq(planEnquiries.id, res.id));
    expect(row.ip).toBe("41.33.1.9");
  });
});

describe("unsentEnquiries", () => {
  // Without a surface that lists them, an undelivered lead is invisible: the
  // visitor is told "we will be in touch" whether or not anything was sent.
  it("lists leads that never reached sales, and omits the ones that did", async () => {
    delete process.env.SALES_INBOX_EMAIL;
    const lost = await createEnquiry({ ...BASE, email: "lost@example.com" }, provider);
    process.env.SALES_INBOX_EMAIL = "sales@serveos.tech";
    await createEnquiry({ ...BASE, email: "delivered@example.com" }, provider);

    const rows = await unsentEnquiries();
    expect(rows.map((r) => r.id)).toEqual([lost.id]);
  });
});

describe("recentlyEnquired", () => {
  it("is false for an address that has never enquired", async () => {
    expect(await recentlyEnquired("nobody@example.com", BASE.planKey)).toBe(false);
  });

  it("is true straight after an enquiry, so the form can throttle", async () => {
    await createEnquiry(BASE, provider);
    expect(await recentlyEnquired(BASE.email, BASE.planKey)).toBe(true);
  });

  it("only throttles the address that enquired", async () => {
    await createEnquiry(BASE, provider);
    expect(await recentlyEnquired("someone.else@example.com", BASE.planKey)).toBe(false);
  });

  // Keyed on email alone, a prospect comparing tiers was told "we already have
  // your request" and sales never learned they had changed their mind.
  it("lets the same prospect ask about a different plan", async () => {
    await createEnquiry(BASE, provider);
    expect(await recentlyEnquired(BASE.email, "pro")).toBe(false);
  });
});

describe("tooManyFromIp", () => {
  it("is false below the cap", async () => {
    await createEnquiry(BASE, provider);
    expect(await tooManyFromIp("41.33.1.9")).toBe(false);
  });

  // The gap the per-email check cannot close: vary the address and every
  // submission is a database write plus a live provider call.
  it("caps one address however many identities it submits under", async () => {
    for (let i = 0; i < IP_HOURLY_LIMIT; i++) {
      await createEnquiry({ ...BASE, email: `prospect-${i}@example.com` }, provider);
    }
    expect(await tooManyFromIp("41.33.1.9")).toBe(true);
  });

  it("does not cap a different address", async () => {
    for (let i = 0; i < IP_HOURLY_LIMIT; i++) {
      await createEnquiry({ ...BASE, email: `prospect-${i}@example.com` }, provider);
    }
    expect(await tooManyFromIp("197.45.0.1")).toBe(false);
  });

  // An unattributable row cannot be rate-limited, and must not cap everyone else.
  it("never caps when no address was captured", async () => {
    for (let i = 0; i < IP_HOURLY_LIMIT; i++) {
      await createEnquiry({ ...BASE, email: `anon-${i}@example.com`, ip: null }, provider);
    }
    expect(await tooManyFromIp(null)).toBe(false);
  });
});
