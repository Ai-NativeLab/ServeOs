import Link from "next/link";
import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { currentCustomer } from "@/server/customers/require-customer";
import { listCustomerOrders } from "@/server/customers/service";
import { orderStatusMeta } from "@/lib/order-status";
import { AccountForms } from "./AccountForms";
import { ProfileForm } from "./ProfileForm";
import { customerSignOutAction } from "./actions";

/** The storefront account page — tenant from the host, like every other
 *  storefront surface. Signed out: login/register. Signed in: profile + orders. */
export default async function AccountPage() {
  const h = await headers();
  const slug = h.get("x-tenant-slug");
  if (h.get("x-surface") !== "storefront" || !slug) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-sm text-muted-foreground">
        Accounts live on each shop&apos;s own site.
      </main>
    );
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) {
    return <main className="grid min-h-screen place-items-center bg-background p-6 text-sm text-muted-foreground">Not found.</main>;
  }

  const me = await currentCustomer(tenant.id);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="flex h-14 items-center justify-between border-b bg-card px-4">
        <Link href="/" className="font-display text-base font-bold tracking-tight text-ink">{tenant.name}</Link>
        {me && (
          <form action={customerSignOutAction}>
            <button className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-secondary">
              Sign out
            </button>
          </form>
        )}
      </header>

      <div className="mx-auto max-w-2xl p-4 md:p-6">
        {!me ? (
          <>
            <h1 className="mb-1 text-center font-display text-xl font-bold text-ink">Your account</h1>
            <p className="mb-6 text-center text-sm text-muted-foreground">
              Track your orders and check out faster. You can always order as a guest.
            </p>
            <AccountForms />
          </>
        ) : (
          <div className="space-y-8">
            <section>
              <h2 className="eyebrow mb-3 text-primary">Profile</h2>
              <ProfileForm name={me.name} phone={me.phone} defaultAddressText={me.defaultAddressText} />
            </section>

            <section>
              <h2 className="eyebrow mb-3 text-primary">Your orders</h2>
              <OrderList tenantId={tenant.id} customerId={me.id} />
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

async function OrderList({ tenantId, customerId }: { tenantId: string; customerId: string }) {
  const orders = await listCustomerOrders(tenantId, customerId);
  if (orders.length === 0) {
    return <p className="text-sm text-muted-foreground">No orders yet — your next one will show up here.</p>;
  }
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {orders.map((o) => {
        const meta = orderStatusMeta(o.status);
        return (
          <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <Link href={`/order/${o.statusToken}`} className="font-medium text-ink hover:underline">
                Order #{o.orderNumber}
              </Link>
              <div className="text-xs text-muted-foreground">
                {o.placedAt.toLocaleDateString()} · {o.fulfillmentType}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.badgeClass}`}>{meta.label}</span>
              <span className="font-mono text-sm text-ink">{Number(o.total).toFixed(2)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
