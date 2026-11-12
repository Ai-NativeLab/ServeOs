/**
 * Builds an absolute URL for a tenant's storefront subdomain.
 *
 * In local dev (when ROOT_DOMAIN contains localhost):
 *   - Uses http://
 *   - Appends dev port (:3000 or process.env.PORT)
 *
 * In production/staging (ROOT_DOMAIN is serveos.tech / qa.serveos.tech):
 *   - Uses https://
 *   - No port suffix
 *
 * Fallback ROOT_DOMAIN is serveos.tech.
 */
export function buildTenantUrl(
  slug: string,
  pathAndQuery?: string,
  options?: { rootDomain?: string; port?: string | number }
): string {
  const envRoot = options?.rootDomain ?? process.env.ROOT_DOMAIN;
  const rootDomain = envRoot ?? (process.env.NODE_ENV === "development" ? "serveos.localhost" : "serveos.tech");

  const isLocalhost = rootDomain.includes("localhost") || rootDomain.startsWith("127.0.0.1");
  const protocol = isLocalhost ? "http" : "https";

  let host = `${slug}.${rootDomain}`;

  // If localhost and rootDomain doesn't already specify a port, attach port
  if (isLocalhost && !rootDomain.includes(":")) {
    const port = options?.port ?? process.env.PORT ?? "3000";
    if (port && port !== "80" && port !== 80 && port !== "443" && port !== 443) {
      host = `${host}:${port}`;
    }
  }

  if (!pathAndQuery) {
    return `${protocol}://${host}`;
  }

  const path = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  return `${protocol}://${host}${path}`;
}
