import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";
import { getActiveBanners } from "@/server/banners/service";
import { listBranches, listDeliveryAreas } from "@/server/branches/service";
import { hasFeature } from "@/server/entitlements/service";
import { getBranchOpenState, isBranchOrderableAt } from "@/server/branches/slots";
import { getWhatsappNumber } from "@/server/tenancy/settings";
import { getPopularProductIds } from "@/server/catalog/popular";
import { formatMoney } from "@/lib/money";
import { BranchSelector } from "./_components/BranchSelector";
import { StorefrontMenu } from "./_components/StorefrontMenu";
import { Hero } from "./_components/storefront/Hero";
import { OpenStateBanner } from "./_components/storefront/OpenStateBanner";
import { RecentOrderStrip } from "./_components/storefront/RecentOrderStrip";
import { StorefrontFooter } from "./_components/storefront/StorefrontFooter";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { MarketingHeader } from "./_components/marketing/Header";
import { MarketingHero } from "./_components/marketing/Hero";
import { MarketingFeatures } from "./_components/marketing/Features";
import { MarketingHowItWorks } from "./_components/marketing/HowItWorks";
import { MarketingCtaBand } from "./_components/marketing/CtaBand";
import { MarketingFooter } from "./_components/marketing/Footer";
import { LangProvider } from "./_components/marketing/LangProvider";

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

    const [banners, menu, branches, orderingEnabled, whatsappNumber, popularSet] = await Promise.all([
      getActiveBanners(tenant.id),
      getPublishedMenu(tenant.id, branchId),
      listBranches(tenant.id),
      hasFeature(tenant.id, "online_ordering"),
      getWhatsappNumber(tenant.id),
      getPopularProductIds(tenant.id),
    ]);

    const activeBranch =
      branches.length === 1 ? branches[0] : (branches.find((b) => b.id === branchId) ?? null);
    const now = new Date();
    const openState = activeBranch ? getBranchOpenState(activeBranch, tenant.timezone, now) : null;
    const paused = activeBranch ? !activeBranch.isActive || !activeBranch.acceptingOrders : false;
    const branchSummaries = branches.map((b) => ({
      id: b.id,
      name: b.name,
      open: isBranchOrderableAt(b, tenant.timezone, now),
    }));

    const areas = activeBranch ? await listDeliveryAreas(tenant.id, activeBranch.id) : [];
    const activeAreas = areas.filter((a) => a.isActive);

    const openLabel = !openState
      ? undefined
      : openState.open
        ? `Open${openState.closesAt ? ` · closes ${openState.closesAt}` : ""}`
        : `Closed${openState.opensAt ? ` · opens ${openState.opensAt}` : ""}`;

    const etaMinutesList = activeAreas
      .map((a) => a.etaMinutes)
      .filter((m): m is number => m !== null);
    const etaLabel =
      etaMinutesList.length === 0
        ? undefined
        : (() => {
            const min = Math.min(...etaMinutesList);
            const max = Math.max(...etaMinutesList);
            return min === max ? `~${min} min` : `~${min}–${max} min`;
          })();

    const minOrderAmounts = activeAreas
      .map((a) => Number(a.minOrderAmount))
      .filter((n) => n > 0);
    const minOrderLabel =
      minOrderAmounts.length === 0
        ? undefined
        : `Min ${formatMoney(Math.min(...minOrderAmounts), tenant.currency)}`;

    return (
      <main className="min-h-screen bg-background">
        <Hero
          name={tenant.name}
          logoUrl={tenant.logoUrl}
          coverImageUrl={tenant.coverImageUrl}
          tagline={tenant.tagline}
          cuisine={tenant.cuisine}
          area={activeBranch?.address ?? null}
          openLabel={openLabel}
          etaLabel={etaLabel}
          minOrderLabel={minOrderLabel}
        />

        {openState && <OpenStateBanner state={openState} paused={paused} />}

        <RecentOrderStrip slug={slug!} />

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
            <StorefrontMenu
              menu={menu}
              branchId={activeBranch?.id ?? null}
              slug={slug!}
              orderingEnabled={orderingEnabled && !paused}
              preorderOnly={openState !== null && !openState.open && !paused}
              branches={branchSummaries}
              currency={tenant.currency}
              popularIds={[...popularSet]}
            />
          )}
        </section>

        <StorefrontFooter
          branch={activeBranch ?? branches[0] ?? null}
          whatsappNumber={whatsappNumber}
        />
      </main>
    );
  }

  return (
    <LangProvider>
      <div className="min-h-screen">
        <MarketingHeader />
        <MarketingHero />
        <MarketingFeatures />
        <MarketingHowItWorks />
        <MarketingCtaBand />
        <MarketingFooter />
      </div>
    </LangProvider>
  );
}
