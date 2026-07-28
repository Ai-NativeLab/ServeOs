import { createHash } from "node:crypto";

export const ZERO_HASH = "0".repeat(64);

export type AuditActorType = "user" | "system" | "device" | "customer";

export type CanonicalInput = {
  prevHash: string;
  seq: number;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  /** RFC3339, fixed millisecond precision — the DB clock captured inside the tx. */
  createdAt: string;
};

/**
 * Deterministic, JSON-round-trip-stable encoding. Runs the exact JSON pass
 * Postgres jsonb persistence runs (JSON.stringify drops undefined/function/
 * symbol-valued keys and applies toJSON, e.g. Date -> ISO string), THEN emits
 * with recursively-sorted keys. Because it normalizes the same way the DB does,
 * the string the WRITER hashes from an in-memory object equals the string the
 * VERIFIER hashes after the row round-trips through the jsonb column, for ANY
 * input — otherwise the verifier would "detect" tamper that is only encoding drift.
 */
function stableStringify(value: unknown): string {
  return sortedEncode(JSON.parse(JSON.stringify(value ?? null)));
}

/** Encode an already JSON-normalized value (no undefined/Date/function) with sorted keys. */
function sortedEncode(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedEncode).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedEncode(obj[k])}`).join(",")}}`;
}

/**
 * The exact byte sequence that gets hashed. The nine fields the spec names, in
 * a fixed order, with the metadata object key-sorted. Nulls are explicit tokens
 * so "no actor" hashes differently from "actor missing from the encoding".
 */
export function canonicalize(input: CanonicalInput): string {
  return stableStringify({
    prevHash: input.prevHash,
    seq: input.seq,
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata,
    createdAt: input.createdAt,
  });
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function entryHash(input: CanonicalInput): string {
  return sha256Hex(canonicalize(input));
}
