import { StorefrontShell, type StorefrontTemplateProps } from "./StorefrontShell";
import { VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY } from "@/server/verticals";
import { ShopBrowser } from "./shop/ShopBrowser";

export function PharmacyStorefront(props: Omit<StorefrontTemplateProps, "accent" | "config" | "catalog">) {
  return (
    <StorefrontShell
      {...props}
      accent={VERTICAL_ACCENTS.pharmacy}
      config={VERTICAL_STOREFRONT_COPY.pharmacy}
      catalog={
        <ShopBrowser
          menu={props.menu}
          branchId={props.activeBranch?.id ?? null}
          slug={props.slug}
          orderingEnabled={props.orderingEnabled && !props.paused}
          preorderOnly={props.openState !== null && !props.openState.open && !props.paused}
          branches={props.branchSummaries}
          currency={props.tenant.currency}
        />
      }
    />
  );
}
