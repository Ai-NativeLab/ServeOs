/**
 * Where to send someone after a successful login.
 *
 * ONLY same-site paths are honoured. `next` arrives from a query string, so an
 * attacker can put anything in it — "https://evil.example" or the
 * protocol-relative "//evil.example", which a browser resolves as an absolute
 * URL. Either would turn our login form into an open redirect: a link that
 * looks like serveos.tech, authenticates the user for real, and then hands
 * them to someone else's page, primed to trust whatever it asks for.
 *
 * A leading "/" that is not "//", with no backslash and no control
 * characters, cannot leave the origin. Anything else falls back to the
 * dashboard.
 *
 * This lives outside actions.ts because that file is "use server": every
 * export there becomes a server action and must be async, so a plain
 * synchronous helper cannot be exported from it — and an untested
 * open-redirect guard is not worth having.
 */
export const DEFAULT_NEXT = "/dashboard";

/** Control characters: browsers strip these before resolving a URL, so
 *  "/\t/evil.example" becomes "//evil.example" — protocol-relative, off-site. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return DEFAULT_NEXT;
  if (!raw.startsWith("/")) return DEFAULT_NEXT;
  if (raw.startsWith("//")) return DEFAULT_NEXT;
  // Backslash is a path separator to some browsers, so "/\evil.example"
  // escapes the origin exactly like "//" does.
  if (raw.includes("\\")) return DEFAULT_NEXT;
  if (CONTROL_CHARS.test(raw)) return DEFAULT_NEXT;
  return raw;
}
