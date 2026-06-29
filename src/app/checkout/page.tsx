import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable, getVatRate } from "@/server/tenancy";
import { listBranches } from "@/server/branches/service";
import { CheckoutForm } from "./CheckoutForm";

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<{ slug?: string; branch?: string }> }) {
  const h = await headers();
  const headerSlug = h.get("x-tenant-slug");
  const { slug: querySlug, branch } = await searchParams;
  const slug = headerSlug ?? querySlug;
  if (!slug) return <main style={{ padding: 32 }}><h1>Not found</h1></main>;

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) return <main style={{ padding: 32 }}><h1>Restaurant not available</h1></main>;

  const [branches, vatRate] = await Promise.all([listBranches(tenant.id), getVatRate(tenant.id)]);
  const branchId = branch ?? branches[0]?.id ?? null;

  return (
    <main style={{ padding: 24, maxWidth: 480, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 22 }}>Checkout — {tenant.name}</h1>
      <CheckoutForm slug={slug} branchId={branchId} vatRate={vatRate} />
    </main>
  );
}
