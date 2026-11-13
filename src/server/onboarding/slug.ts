/**
 * The storefront subdomain rule, in one place: registerTenant enforces it, the
 * register form reports it per field, and the input's `pattern` attribute lets
 * the browser catch it before a round-trip. Pure, so the client form can
 * import it.
 *
 * 3–32 characters, lowercase letters, digits and hyphens, not starting or
 * ending with a hyphen.
 */
export const SLUG_PATTERN = "[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])";
export const SLUG_RE = new RegExp(`^${SLUG_PATTERN}$`);
export const SLUG_RULE =
  "Use 3–32 lowercase letters, numbers or hyphens, not starting or ending with a hyphen.";

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}
