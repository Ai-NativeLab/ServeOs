/** Matches only http(s) URLs — used to reject javascript:/data: hrefs (stored-XSS guard). */
export const HTTP_URL_RE = /^https?:\/\//i;

export function isHttpUrl(url: string | null | undefined): boolean {
  return !!url && HTTP_URL_RE.test(url);
}

/** Returns the URL only if it is a well-formed http(s) URL, else null. */
export function sanitizeHttpUrl(url: string | null | undefined): string | null {
  return url && HTTP_URL_RE.test(url.trim()) ? url.trim() : null;
}
