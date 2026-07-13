import { StorefrontShell, type StorefrontTemplateProps } from "./StorefrontShell";
import { VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY } from "@/server/verticals";

export function RetailStorefront(props: Omit<StorefrontTemplateProps, "accent" | "config">) {
  return (
    <StorefrontShell
      {...props}
      accent={VERTICAL_ACCENTS.retail}
      config={VERTICAL_STOREFRONT_COPY.retail}
    />
  );
}
