import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";
import { getActiveBanners } from "@/server/banners/service";
import { listBranches } from "@/server/branches/service";
import { hasFeature } from "@/server/entitlements/service";
import { BranchSelector } from "./_components/BranchSelector";
import { StorefrontMenu } from "./_components/StorefrontMenu";
import { MarketingHeader } from "./_components/marketing/Header";
import { MarketingHero } from "./_components/marketing/Hero";
import { MarketingFeatures } from "./_components/marketing/Features";
import { MarketingHowItWorks } from "./_components/marketing/HowItWorks";
import { MarketingCtaBand } from "./_components/marketing/CtaBand";
import { MarketingFooter } from "./_components/marketing/Footer";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>;
}) {
  const h = await headers();
  const surface = h.get("x-surface");
  const slug = h.get("x-tenant-slug");

  if (surface === "storefront" && slug) {
    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      return <main style={{ padding: 48, fontFamily: "system-ui" }}><h1>Restaurant not found</h1></main>;
    }
    if (!isTenantServable(tenant)) {
      return (
        <main style={{ padding: 48, fontFamily: "system-ui" }}>
          <h1>{tenant.name}</h1>
          <p>This restaurant is getting ready. Check back soon!</p>
        </main>
      );
    }

    const { branch: branchId } = await searchParams;

    const [banners, menu, branches, orderingEnabled] = await Promise.all([
      getActiveBanners(tenant.id),
      getPublishedMenu(tenant.id, branchId),
      listBranches(tenant.id),
      hasFeature(tenant.id, "online_ordering"),
    ]);

    return (
      <main style={{ fontFamily: "system-ui" }}>
        {banners.length > 0 && (
          <section style={{ display: "flex", gap: 8, overflowX: "auto", padding: "16px 24px" }}>
            {banners.map((b) => (
              <a key={b.id} href={b.linkUrl ?? "#"}>
                <img src={b.imageUrl} alt={b.titleEn ?? ""} style={{ height: 160, borderRadius: 8 }} />
              </a>
            ))}
          </section>
        )}

        {branches.length > 1 && (
          <section style={{ padding: "8px 24px" }}>
            <BranchSelector branches={branches} currentBranchId={branchId} />
          </section>
        )}

        <section style={{ padding: "0 24px 32px" }}>
          <h1 style={{ fontSize: 28, marginBottom: 4 }}>{tenant.name}</h1>
          {menu.categories.length === 0 && <p>Menu coming soon.</p>}
          <StorefrontMenu menu={menu} branchId={branchId ?? null} slug={slug!} orderingEnabled={orderingEnabled} />
        </section>
      </main>
    );
  }

  return (
    <div className="min-h-screen">
      <MarketingHeader />
      <MarketingHero />
      <MarketingFeatures />
      <MarketingHowItWorks />
      <MarketingCtaBand />
      <MarketingFooter />
    </div>
  );
}
