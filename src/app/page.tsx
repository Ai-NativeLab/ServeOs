import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";
import { getActiveBanners } from "@/server/banners/service";
import { listBranches } from "@/server/branches/service";
import { hasFeature } from "@/server/entitlements/service";
import { BranchSelector } from "./_components/BranchSelector";
import { StorefrontMenu } from "./_components/StorefrontMenu";
import { Hero } from "./_components/storefront/Hero";
import { EmptyState } from "@/components/dashboard/EmptyState";
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
      return (
        <main className="grid min-h-screen place-items-center bg-background p-6">
          <EmptyState title="Restaurant not found" />
        </main>
      );
    }
    if (!isTenantServable(tenant)) {
      return (
        <main className="grid min-h-screen place-items-center bg-background p-6">
          <EmptyState title={tenant.name} description="This restaurant is getting ready. Check back soon!" />
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
      <main className="min-h-screen bg-background">
        <Hero name={tenant.name} logoUrl={tenant.logoUrl} coverImageUrl={tenant.coverImageUrl} primaryColor={tenant.primaryColor} />

        {banners.length > 0 && (
          <section className="flex gap-3 overflow-x-auto px-4 py-4 sm:px-6">
            {banners.map((b) => (
              <a key={b.id} href={b.linkUrl ?? "#"} className="shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={b.imageUrl} alt={b.titleEn ?? ""} className="h-36 rounded-xl object-cover" />
              </a>
            ))}
          </section>
        )}

        {branches.length > 1 && (
          <section className="px-4 pb-2 sm:px-6">
            <BranchSelector branches={branches} currentBranchId={branchId} />
          </section>
        )}

        <section className="px-4 pb-32 sm:px-6">
          {menu.categories.length === 0 ? (
            <EmptyState title="Menu coming soon" description="This restaurant hasn't published a menu yet." />
          ) : (
            <StorefrontMenu menu={menu} branchId={branchId ?? null} slug={slug!} orderingEnabled={orderingEnabled} />
          )}
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
