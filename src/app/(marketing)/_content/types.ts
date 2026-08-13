import type { Locale } from "@/shared/errors";

/**
 * Every content module exports the same shape in both languages. The type makes
 * a missing translation a compile error; keyPaths + parity.test.ts catch the
 * cases types cannot, such as an array whose items gained a field in one
 * language only.
 */
export type Localized<T> = Record<Locale, T>;

/**
 * Sorted, dot-joined key paths. An array contributes its FIRST element's shape
 * under `name[]` — length may legitimately differ between languages, item shape
 * may not. Descending matters: footer links, FAQ items, features, steps, ticket
 * lines and outcomes are all arrays, so collapsing them would leave most of the
 * content unchecked.
 */
export function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.length === 0 ? [`${prefix}[]`] : keyPaths(value[0], `${prefix}[]`);
  }
  if (value === null || typeof value !== "object") return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}
