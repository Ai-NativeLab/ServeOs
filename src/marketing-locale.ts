/**
 * Locale routing for the marketing surface only.
 *
 * `/` is shared: on a tenant host it is a storefront, on the root domain it is
 * marketing. So the locale prefix cannot be applied globally — the proxy calls
 * this only after classifyHost() has returned `marketing`.
 *
 * Arabic is the default and keeps the bare `/` URL; `/ar` exists as a route
 * internally but redirects, so each language has exactly one canonical URL.
 */
export type LocaleAction =
  | { kind: "rewrite"; pathname: string; locale: "ar" }
  | { kind: "pass"; locale: "en" }
  | { kind: "redirect"; pathname: string }
  | { kind: "none" };

/**
 * Marketing pages that live under the [lang] segment but are reached without a
 * locale prefix, the same way `/` is.
 *
 * An ALLOWLIST, deliberately — never "rewrite anything unmatched". The `none`
 * fallthrough at the end of marketingLocaleAction is what keeps `/login`,
 * `/register` and `/api/health` out of the marketing segment; rewriting those
 * would break sign-in.
 */
const MARKETING_PATHS = new Set(["/pricing"]);

export function marketingLocaleAction(pathname: string): LocaleAction {
  if (pathname === "/") return { kind: "rewrite", pathname: "/ar", locale: "ar" };
  if (pathname === "/en" || pathname.startsWith("/en/")) return { kind: "pass", locale: "en" };
  if (pathname === "/ar") return { kind: "redirect", pathname: "/" };
  if (pathname.startsWith("/ar/")) return { kind: "redirect", pathname: pathname.slice(3) };
  if (MARKETING_PATHS.has(pathname)) {
    return { kind: "rewrite", pathname: `/ar${pathname}`, locale: "ar" };
  }
  return { kind: "none" };
}
