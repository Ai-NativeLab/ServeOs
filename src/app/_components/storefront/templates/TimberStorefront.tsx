import { StorefrontShell, type StorefrontTemplateProps } from "./StorefrontShell";
import { VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY } from "@/server/tenancy/verticals";

export function TimberStorefront(props: Omit<StorefrontTemplateProps, "accent" | "config">) {
  return (
    <StorefrontShell
      {...props}
      accent={VERTICAL_ACCENTS.timber}
      config={VERTICAL_STOREFRONT_COPY.timber}
    />
  );
}
