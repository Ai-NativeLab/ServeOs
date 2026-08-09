import { requireOrdersPermission } from "../../orders-permission";
import { listSales, endOfDay, type SalesFilters } from "@/server/pos/sales-history";
import { toOrderRow } from "@/server/ordering/service";
import { getTenantById } from "@/server/tenancy";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SalesHistoryTable, type SalesHistoryRow } from "../SalesHistoryTable";

const inputCls =
  "rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-ink placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

export default async function SalesHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantId } = await requireOrdersPermission();
  const sp = await searchParams;
  const first = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const from = first("from");
  const to = first("to");
  const cashier = first("cashier");
  const orderNumber = first("orderNumber");
  const phone = first("phone");
  const amount = first("amount");

  const filters: SalesFilters = {
    dateFrom: from ? new Date(from) : undefined,
    dateTo: to ? endOfDay(to) : undefined,
    cashierUserId: cashier,
    customerPhone: phone,
    orderNumber: orderNumber ? Number(orderNumber) : undefined,
    amount: amount ? Number(amount) : undefined,
  };

  const sales = await listSales(tenantId, filters);
  const tenant = await getTenantById(tenantId);
  const rows: SalesHistoryRow[] = sales.map((o) => ({ ...toOrderRow(o), placedAt: o.placedAt.toISOString() }));

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Sales history"
        description="Finalized sales, newest first. A refunded sale stays here as refunded or partially refunded."
      />
      <form method="get" className="mb-4 grid gap-2 rounded-xl border bg-card p-3 sm:grid-cols-2 lg:grid-cols-7">
        <input name="from" type="date" defaultValue={from} aria-label="From date" className={inputCls} />
        <input name="to" type="date" defaultValue={to} aria-label="To date" className={inputCls} />
        <input name="orderNumber" type="number" min={1} defaultValue={orderNumber} placeholder="Order #" aria-label="Order number" className={inputCls} />
        <input name="phone" type="text" defaultValue={phone} placeholder="Customer phone" aria-label="Customer phone" className={inputCls} />
        <input name="amount" type="number" min={0} step="0.01" defaultValue={amount} placeholder="Amount" aria-label="Amount" className={inputCls} />
        <input name="cashier" type="text" defaultValue={cashier} placeholder="Cashier ID" aria-label="Cashier ID" className={inputCls} />
        <button type="submit" className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground">
          Search
        </button>
      </form>
      <SalesHistoryTable initial={rows} timezone={tenant?.timezone ?? "Africa/Cairo"} />
    </>
  );
}
