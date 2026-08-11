import type { VerticalId } from "@/server/verticals";

export type DemoEntry = { storefrontUrl: string; dashboardUrl: string };

/**
 * Where the marketing page's two demo doors lead.
 *
 * Deliberately separate slugs from the `roma` / `nobio` showcase tenants: the
 * demo is publicly writable and reset nightly, and coupling that to a showcase
 * tenant would mean one visitor's test order defaces the other.
 *
 * The tenants themselves, the /api/demo/login route and the reset job are owned
 * by the demo-tenants spec. Until it ships, these links resolve to nothing.
 */
export function getDemoEntry(
  trade: VerticalId,
  rootDomain: string = process.env.ROOT_DOMAIN ?? "serveos.localhost",
): DemoEntry {
  const isLocal = rootDomain === "localhost" || rootDomain.endsWith(".localhost");
  const protocol = isLocal ? "http:" : "https:";
  return {
    storefrontUrl: `${protocol}//demo-${trade}.${rootDomain}`,
    dashboardUrl: `/api/demo/login?trade=${trade}`,
  };
}
