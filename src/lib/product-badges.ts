const NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** True when the product was created within the last 14 days. */
export function isNewProduct(createdAt: string | Date, now: Date = new Date()): boolean {
  return now.getTime() - new Date(createdAt).getTime() < NEW_WINDOW_MS;
}
