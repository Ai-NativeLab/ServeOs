import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { enumerateMutatingSymbols, extractFunctionBody, basename, AUDIT_ALLOWLIST } from "./coverage";

/**
 * The calls that count as emitting an audit event.
 *
 * `recordFiscalAudit` (`fiscal/effects.ts`) is on the list because it IS an
 * emission: a thin named wrapper that calls `recordAuditEvent` on the caller's
 * transaction with `entityType` fixed to `"eta_submission"`. Recognising a real
 * emitter is not a loophole — a domain that funnels its events through one
 * named wrapper is exactly what this guardrail wants to see, and the wrapper is
 * the reason the fiscal event vocabulary lives in one file instead of being
 * restated at every call site.
 */
const EMIT_RE = /recordAuditEvent\s*\(|recordAuthEvent\s*\(|recordFinancialView\s*\(|recordCustomerPiiView\s*\(|recordFiscalAudit\s*\(/;

describe("audit coverage guardrail", () => {
  it("every mutating service function emits an audit event (or is allowlisted)", () => {
    const gaps: string[] = [];
    for (const sym of enumerateMutatingSymbols()) {
      const src = readFileSync(sym.file, "utf8");
      const body = extractFunctionBody(src, sym.name);
      const emits = EMIT_RE.test(body);
      const key = `${basename(sym.file)}.${sym.name}`;
      if (!emits && !(key in AUDIT_ALLOWLIST)) gaps.push(key);
    }
    expect(gaps, `Mutating functions with no audit emission and no allowlist entry:\n${gaps.join("\n")}`).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const live = new Set(enumerateMutatingSymbols().map((s) => `${basename(s.file)}.${s.name}`));
    for (const key of Object.keys(AUDIT_ALLOWLIST)) {
      if (key.startsWith("forward:")) continue;
      expect(live.has(key), `stale allowlist entry: ${key}`).toBe(true);
    }
  });

  it("finds the known mutating surface (guards against a silently empty scan)", () => {
    expect(enumerateMutatingSymbols().length).toBeGreaterThan(20);
  });
});
