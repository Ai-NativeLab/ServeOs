import { describe, it, expect } from "vitest";
import { canonicalize, sha256Hex, entryHash, ZERO_HASH, type CanonicalInput } from "./canonical";

const base: CanonicalInput = {
  prevHash: ZERO_HASH,
  seq: 1,
  tenantId: "11111111-1111-1111-1111-111111111111",
  actorUserId: null,
  action: "order.placed",
  entityType: "order",
  entityId: "order-1",
  metadata: { total: "125.40", channel: "pos" },
  createdAt: "2026-07-24T10:00:00.000Z",
};

describe("canonicalize", () => {
  it("is stable regardless of metadata key order", () => {
    const a = canonicalize({ ...base, metadata: { total: "125.40", channel: "pos" } });
    const b = canonicalize({ ...base, metadata: { channel: "pos", total: "125.40" } });
    expect(a).toBe(b);
  });

  it("encodes a null actor explicitly (not as absent)", () => {
    expect(canonicalize(base)).toContain('"actorUserId":null');
  });

  it("changes when any hashed field changes", () => {
    expect(canonicalize(base)).not.toBe(canonicalize({ ...base, seq: 2 }));
    expect(canonicalize(base)).not.toBe(canonicalize({ ...base, entityId: "order-2" }));
    expect(canonicalize(base)).not.toBe(canonicalize({ ...base, action: "order.cancelled" }));
  });

  it("drops undefined-valued metadata keys, matching JSON.stringify/jsonb round-trip", () => {
    expect(canonicalize({ ...base, metadata: { a: 1, note: undefined } }))
      .toBe(canonicalize({ ...base, metadata: { a: 1 } }));
  });

  it("hashes different Date values in metadata differently (honors toJSON like jsonb does)", () => {
    expect(canonicalize({ ...base, metadata: { at: new Date("2026-01-01T00:00:00.000Z") } }))
      .not.toBe(canonicalize({ ...base, metadata: { at: new Date("2020-01-01T00:00:00.000Z") } }));
  });

  it("is invariant across a JSON round-trip of the metadata (writer vs verifier agree)", () => {
    const meta = { at: new Date("2026-01-01T00:00:00.000Z"), note: undefined, n: 2, s: "x" };
    const roundTripped = JSON.parse(JSON.stringify(meta));
    expect(canonicalize({ ...base, metadata: meta }))
      .toBe(canonicalize({ ...base, metadata: roundTripped }));
  });

  it("changes when prevHash or metadata content changes (not just key order)", () => {
    expect(canonicalize(base)).not.toBe(canonicalize({ ...base, prevHash: "1".repeat(64) }));
    expect(canonicalize(base)).not.toBe(canonicalize({ ...base, metadata: { total: "999.99", channel: "pos" } }));
  });

  it("drops function/symbol-valued metadata keys, matching the jsonb round-trip", () => {
    const meta = { keep: 1, fn: () => 42, sym: Symbol("x") } as unknown as Record<string, unknown>;
    expect(canonicalize({ ...base, metadata: meta }))
      .toBe(canonicalize({ ...base, metadata: JSON.parse(JSON.stringify(meta)) }));
  });
});

describe("sha256Hex", () => {
  it("matches a known vector", () => {
    // echo -n "serveos" | shasum -a 256
    expect(sha256Hex("serveos")).toBe("010c67077dee8b2f60b3704c2075023e496f34a9ac2ae2a29f1aefd952670ff7");
  });

  it("is 64 lowercase hex chars", () => {
    expect(entryHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ZERO_HASH", () => {
  it("is 64 zeros (genesis prevHash)", () => {
    expect(ZERO_HASH).toBe("0000000000000000000000000000000000000000000000000000000000000000");
  });
});
