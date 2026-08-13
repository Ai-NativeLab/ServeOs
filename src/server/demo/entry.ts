import type { VerticalId } from "@/server/verticals";

export type DemoEntry = { storefrontUrl: string; dashboardUrl: string };

/**
 * The tenant slug behind each demo door, and the ONLY slug shape the demo
 * login will ever sign anyone into.
 *
 * One definition, three consumers — the marketing links, the seed script and
 * the login route — because the whole safety story of a public login endpoint
 * rests on it being impossible to point at a real tenant.
 */
export function demoSlug(trade: VerticalId): string {
  return `demo-${trade}`;
}

/** True only for slugs this module owns. The login route refuses anything else. */
export function isDemoSlug(slug: string): boolean {
  return slug.startsWith("demo-");
}

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
