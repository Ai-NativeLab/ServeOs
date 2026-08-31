import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";
import { getActiveBanners } from "@/server/banners/service";
import { listBranches, listDeliveryAreas } from "@/server/branches/service";
import { hasFeature } from "@/server/entitlements/service";
import { getBranchOpenState, isBranchOrderableAt } from "@/server/branches/slots";
import { getWhatsappNumber, getCatalogDisplaySettings } from "@/server/tenancy/settings";
import { getPopularProductIds } from "@/server/catalog/popular";
import { formatMoney } from "@/lib/money";
import { selectStorefrontTemplate, getVerticalTerms, type VerticalId } from "@/server/verticals";
import { redeemHandoff } from "@/server/whatsapp/handoff";
import { HandoffCartSeed } from "./_components/storefront/HandoffCartSeed";
import type { PublishedMenu } from "@/server/catalog/schema";
import type { CartLine as StoreCartLine } from "./_components/cart";
import { RestaurantStorefront } from "./_components/storefront/templates/RestaurantStorefront";
import { RetailStorefront } from "./_components/storefront/templates/RetailStorefront";
import { PharmacyStorefront } from "./_components/storefront/templates/PharmacyStorefront";
import { TimberStorefront } from "./_components/storefront/templates/TimberStorefront";
import { EmptyState } from "@/components/dashboard/EmptyState";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; handoff?: string }>;
}) {
  const h = await headers();
  const surface = h.get("x-surface");
  const slug = h.get("x-tenant-slug");

  if (surface === "storefront" && slug) {
    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      return (
        <main className="grid min-h-screen place-items-center bg-background p-6">
          <EmptyState title="Not found" />
        </main>
      );
    }
    if (!isTenantServable(tenant)) {
      const terms = getVerticalTerms(selectStorefrontTemplate(tenant.vertical as VerticalId));
      return (
        <main className="grid min-h-screen place-items-center bg-background p-6">
          <EmptyState title={tenant.name} description={terms.gettingReadyBody.en} />
        </main>
      );
    }

    const { branch: branchId, handoff } = await searchParams;

    // A WhatsApp cart handed to the storefront. Redeemed server-side,
    // single-use, and scoped by RLS to THIS host's tenant — a token minted for
    // another tenant returns null here rather than rendering their cart under
    // our brand. The tenant comes from the host header, never from the token.
    const handoffToken = handoff ? await redeemHandoff(tenant.id, handoff) : null;

    const [banners, menu, branches, orderingEnabled, whatsappNumber, popularSet, displaySettings] = await Promise.all([
      getActiveBanners(tenant.id),
      getPublishedMenu(tenant.id, branchId),
      listBranches(tenant.id),
      hasFeature(tenant.id, "online_ordering"),
      getWhatsappNumber(tenant.id),
      getPopularProductIds(tenant.id),
      getCatalogDisplaySettings(tenant.id),
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

    const resolvedVertical = selectStorefrontTemplate(tenant.vertical);
    const Template = {
      restaurant: RestaurantStorefront,
      retail: RetailStorefront,
      pharmacy: PharmacyStorefront,
      timber: TimberStorefront,
    }[resolvedVertical];

    // Resolve the handed-off id-only lines against the published menu NOW, so
    // the seeded cart carries current names and prices — a line whose product
    // has since unpublished simply drops out.
    const handoffLines = handoffToken ? resolveHandoffLines(menu, handoffToken.cart) : [];

    return (
      <>
        {handoffLines.length > 0 && (
          <HandoffCartSeed branchId={handoffToken?.branchId ?? activeBranch?.id ?? null} lines={handoffLines} />
        )}
        <Template
        tenant={{
          name: tenant.name,
          logoUrl: tenant.logoUrl,
          coverImageUrl: tenant.coverImageUrl,
          tagline: tenant.tagline,
          cuisine: tenant.cuisine,
          currency: tenant.currency,
        }}
        banners={banners}
        menu={menu}
        branches={branches}
        branchSummaries={branchSummaries}
        activeBranch={activeBranch}
        openState={openState}
        paused={paused}
        orderingEnabled={orderingEnabled}
        slug={slug!}
        popularIds={[...popularSet]}
        whatsappNumber={whatsappNumber}
        openLabel={openLabel}
        etaLabel={etaLabel}
        minOrderLabel={minOrderLabel}
        catalogDisplayMode={displaySettings.catalogDisplayMode}
        itemsPerPage={displaySettings.itemsPerPage}
      />
      </>
    );
  }

  // Marketing lives at src/app/(marketing)/[lang]; the proxy rewrites the
  // marketing host's "/" to "/ar", so this route only ever serves storefronts.
  notFound();
}

/**
 * Maps a WhatsApp handoff's id-only cart lines onto the published menu,
 * producing the display-ready lines the storefront cart store expects.
 * Unresolvable lines (product unpublished since the chat) are dropped.
 */
function resolveHandoffLines(
  menu: PublishedMenu,
  cart: { productId: string; variantId?: string; quantity: number }[],
): StoreCartLine[] {
  const products = menu.categories.flatMap((c) => c.products);
  const lines: StoreCartLine[] = [];
  for (const l of cart) {
    const p = products.find((x) => x.id === l.productId);
    if (!p) continue;
    const v = l.variantId ? p.variants.find((x) => x.id === l.variantId) : undefined;
    if (l.variantId && !v) continue;
    lines.push({
      productId: p.id,
      variantId: v?.id,
      variantNameEn: v?.nameEn,
      nameEn: p.nameEn,
      nameAr: p.nameAr,
      quantity: l.quantity,
      unitPrice: v?.price ?? p.effectivePrice,
      selectedOptionIds: [],
      modifierSummaryEn: "",
    });
  }
  return lines;
}
