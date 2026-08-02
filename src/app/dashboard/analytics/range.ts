export const RANGES = ["7", "30", "90"] as const;

export function parseRange(value: unknown): number {
  return RANGES.includes(value as (typeof RANGES)[number]) ? Number(value) : 30;
}
