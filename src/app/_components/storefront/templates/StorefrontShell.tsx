import type { PublishedMenu } from "@/server/catalog/schema";
import type { Banner } from "@/server/banners/schema";
import type { Branch } from "@/server/branches/schema";
import type { BranchOpenState } from "@/server/branches/slots";
import type { Tenant } from "@/server/tenancy/schema";
import type { VerticalStorefrontCopy } from "@/server/tenancy/verticals";
import { Hero } from "../Hero";
import { OpenStateBanner } from "../OpenStateBanner";
import { RecentOrderStrip } from "../RecentOrderStrip";
import { StorefrontMenu } from "@/app/_components/StorefrontMenu";
import { StorefrontFooter } from "../StorefrontFooter";
import { BranchSelector } from "@/app/_components/BranchSelector";
import { EmptyState } from "@/components/dashboard/EmptyState";

export type StorefrontTemplateProps = {
  tenant: Pick<Tenant, "name" | "logoUrl" | "coverImageUrl" | "tagline" | "cuisine" | "currency">;
  accent: string;
  config: VerticalStorefrontCopy;
  banners: Banner[];
  menu: PublishedMenu;
  branches: Branch[];
  branchSummaries: { id: string; name: string; open: boolean }[];
  activeBranch: Branch | null;
  openState: BranchOpenState | null;
  paused: boolean;
  orderingEnabled: boolean;
  slug: string;
  popularIds: string[];
  whatsappNumber: string | null;
  openLabel?: string | null;
  etaLabel?: string | null;
  minOrderLabel?: string | null;
};

export function StorefrontShell(props: StorefrontTemplateProps) {
  const {
    tenant, accent, config, banners, menu, branches, branchSummaries,
    activeBranch, openState, paused, orderingEnabled, slug, popularIds,
    whatsappNumber, openLabel, etaLabel, minOrderLabel,
  } = props;

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

      <RecentOrderStrip slug={slug} />

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
          <BranchSelector branches={branches} currentBranchId={activeBranch?.id ?? undefined} />
        </section>
      )}

      <section className="px-4 pb-32 sm:px-6">
        <h2 className="mb-4 font-display text-xl font-bold text-ink" style={{ color: accent }}>
          {config.menuHeading}
        </h2>
        {menu.categories.length === 0 ? (
          <EmptyState title={config.emptyMenuTitle} description={config.emptyMenuDesc} />
        ) : (
          <StorefrontMenu
            menu={menu}
            branchId={activeBranch?.id ?? null}
            slug={slug}
            orderingEnabled={orderingEnabled && !paused}
            preorderOnly={openState !== null && !openState.open && !paused}
            branches={branchSummaries}
            currency={tenant.currency}
            popularIds={[...popularIds]}
          />
        )}
      </section>

      <StorefrontFooter
        branch={activeBranch ?? branches[0] ?? null}
        whatsappNumber={config.showWhatsapp ? whatsappNumber : null}
      />
    </main>
  );
}
