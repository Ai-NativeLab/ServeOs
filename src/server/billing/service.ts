import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { invoices, type Invoice } from "./schema";

/** invoices is a control table (like subscriptions/plans) → plain db, matching ManualBillingProvider. */
export async function listInvoicesForTenant(tenantId: string): Promise<Invoice[]> {
  return db.select().from(invoices).where(eq(invoices.tenantId, tenantId)).orderBy(desc(invoices.createdAt));
}
