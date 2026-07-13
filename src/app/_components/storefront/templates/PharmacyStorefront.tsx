import { StorefrontShell, type StorefrontTemplateProps } from "./StorefrontShell";
import { VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY } from "@/server/verticals";

export function PharmacyStorefront(props: Omit<StorefrontTemplateProps, "accent" | "config">) {
  return (
    <StorefrontShell
      {...props}
      accent={VERTICAL_ACCENTS.pharmacy}
      config={VERTICAL_STOREFRONT_COPY.pharmacy}
    />
  );
}
