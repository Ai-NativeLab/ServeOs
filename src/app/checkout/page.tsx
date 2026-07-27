import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable, getCheckoutPricing } from "@/server/tenancy";
import { listBranches } from "@/server/branches/service";
import { getBranchOpenState, listSlots, localDateKey } from "@/server/branches/slots";
import { formatSlotLabel } from "@/lib/datetime";
import { listEnabledOfflineMethods } from "@/server/payments/offline/methods";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { CheckoutForm, type SlotOption } from "./CheckoutForm";

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string; branch?: string }>;
}) {
  const h = await headers();
  const headerSlug = h.get("x-tenant-slug");
  const { slug: querySlug, branch: branchParam } = await searchParams;
  const slug = headerSlug ?? querySlug;
  if (!slug) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <EmptyState title="Not found" />
      </main>
    );
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <EmptyState title="Restaurant not available" />
      </main>
    );
  }

  const [branches, pricing, offlineMethods] = await Promise.all([
    listBranches(tenant.id),
    getCheckoutPricing(tenant.id),
    listEnabledOfflineMethods(tenant.id),
  ]);
  // No silent fallback: resolve only an explicit ?branch= or the single branch.
  const branch =
    branches.length === 1 ? branches[0] : (branches.find((b) => b.id === branchParam) ?? null);
  if (!branch) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <EmptyState
          title="Choose a branch first"
          description="Head back to the menu and pick a branch before checking out."
        />
      </main>
    );
  }

  const now = new Date();
  const openState = getBranchOpenState(branch, tenant.timezone, now);
  const today = localDateKey(now, tenant.timezone);
  const slots: SlotOption[] = listSlots(branch, tenant.timezone, now).map((d) => ({
    iso: d.toISOString(),
    label: formatSlotLabel(d, tenant.timezone),
    day: localDateKey(d, tenant.timezone) === today ? "Today" : "Tomorrow",
  }));

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-md">
        {/* NOTE (deviation from Task 9 brief, see integration note 4): the brief
            renders "Checkout" as a non-heading eyebrow <div> and puts the tenant
            name in the <h1>. That would break the existing e2e assertion
            getByRole("heading", { name: /Checkout/ }) (tests/e2e/ordering.spec.ts).
            To keep that test passing, "Checkout" is the <h1> here and the tenant
            name is a <p> styled as the brief's h1 was. Task 12 may reconcile this
            further when the full e2e suite is rebuilt. */}
        <header className="border-b border-border pb-4">
          <h1 className="eyebrow text-muted-foreground">Checkout</h1>
          <p className="mt-1 font-display text-2xl font-extrabold text-ink">{tenant.name}</p>
          <p className="text-sm text-muted-foreground">{branch.name}</p>
        </header>
        <CheckoutForm
          slug={slug}
          branchId={branch.id}
          branchName={branch.name}
          pricing={pricing}
          currency={tenant.currency}
          openNow={openState.open && branch.isActive && branch.acceptingOrders}
          slots={slots}
          methods={offlineMethods.map((m) => ({ type: m.type, label: m.label, payToDetail: m.payToDetail }))}
        />
      </div>
    </main>
  );
}
