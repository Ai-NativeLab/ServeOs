import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  enumerateMutatingSymbols, extractFunctionBody, basename,
  AUDIT_ALLOWLIST, AUDITED_SERVICE_FILES, PENDING_SCAN_PREFIX,
} from "./coverage";

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
      // A `pending-scan:` entry counts here as well as a plain one. Those are
      // dispositions written in advance for writers the CURRENT scan cannot see
      // (it matches `export function` only), so that the day Task 10b widens the
      // reach they take effect immediately instead of surfacing as fresh gaps for
      // someone else to adjudicate. Honouring the prefix is what makes the
      // pre-decision real rather than a comment.
      if (!emits && !(key in AUDIT_ALLOWLIST) && !(`${PENDING_SCAN_PREFIX}${key}` in AUDIT_ALLOWLIST)) gaps.push(key);
    }
    expect(gaps, `Mutating functions with no audit emission and no allowlist entry:\n${gaps.join("\n")}`).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const live = new Set(enumerateMutatingSymbols().map((s) => `${basename(s.file)}.${s.name}`));
    for (const key of Object.keys(AUDIT_ALLOWLIST)) {
      if (key.startsWith("forward:")) continue;
      // `pending-scan:` keys name PRIVATE writers, which `enumerateMutatingSymbols`
      // cannot enumerate yet — requiring them to be live would be requiring the
      // impossible. So the exemption is INVERTED rather than skipped: the entry
      // must still be un-enumerable, and the moment it stops being so, this fails
      // BY NAME with the fix in the message.
      //
      // THE HATCH CLOSES ITSELF, which is the whole reason to spell it this way.
      // A bare `continue` would leave the prefix's removal depending on Task 10b
      // remembering that these entries exist — and a temporary marker whose
      // cleanup depends on someone's memory is a permanent one. Here, widening the
      // scan turns every stale prefix into a failing assertion that names the key
      // and says what to do about it, so the migration is driven by the guardrail
      // instead of by a note in a plan.
      if (key.startsWith(PENDING_SCAN_PREFIX)) {
        const bare = key.slice(PENDING_SCAN_PREFIX.length);
        expect(live.has(bare), `pending-scan entry is now enumerable — drop the prefix: ${key}`).toBe(false);
        continue;
      }
      expect(live.has(key), `stale allowlist entry: ${key}`).toBe(true);
    }
  });

  /**
   * ZERO ENTRIES TODAY, and that is the mechanism having worked rather than
   * having been abandoned: its only user, `worker.noteLateSubmission`, graduated
   * to a plain key the moment Task 10b's widening reached it. The prefix is kept
   * for the NEXT reach-widening — class methods and nested writers are still out
   * of scope — but it is decoration until something uses it. If it still has no
   * users after that widening, delete it rather than keep an escape hatch nobody
   * needs; an unused exemption on a guardrail is an invitation to park an
   * undecided writer in it.
   */
  it("keeps every pending-scan disposition pointed at a real private writer", () => {
    // THE ESCAPE HATCH NEEDS ITS OWN GUARD, or `pending-scan:` becomes a way to
    // keep dead entries forever: exempt from the stale test by construction, and
    // invisible to the coverage test until someone widens the scan. So the two
    // things that make the entry meaningful are checked directly — the file
    // exists, and it really does contain a function by that name. What is NOT
    // checked is that the function writes; that judgement is the widened
    // scanner's job (Task 10b), and duplicating a weaker version of it here
    // would be a second answer to the same question.
    for (const key of Object.keys(AUDIT_ALLOWLIST)) {
      if (!key.startsWith(PENDING_SCAN_PREFIX)) continue;
      const [file, symbol] = key.slice(PENDING_SCAN_PREFIX.length).split(".");
      // Resolved against the SCANNED FILE LIST, not against the symbols the scan
      // currently yields: the whole point of the prefix is that the symbol is not
      // yielded yet, but its file is already in scope and will be re-read the
      // moment the reach widens.
      const matches = AUDITED_SERVICE_FILES.filter((f) => basename(f) === file);
      expect(matches.length, `pending-scan key names no scanned file: ${key}`).toBeGreaterThan(0);
      // ANY matching file, not the first: this key scheme is `<basename>.<symbol>`
      // and three scanned files are called `worker.ts` (notifications, fiscal,
      // and whatsapp's status-worker), so resolving to `matches[0]` would have
      // looked for a fiscal function inside the notifications worker and failed
      // for a reason that has nothing to do with the entry. The ambiguity is the
      // existing scheme's, inherited rather than introduced — the allowlist has
      // always been keyed this way — and it is bounded here rather than fixed,
      // because renaming every key to a full path is a change to a guardrail this
      // task should not be reshaping.
      const found = matches.some((f) => new RegExp(`function\\s+${symbol}\\b`).test(readFileSync(f, "utf8")));
      expect(found, `pending-scan key names no such function: ${key}`).toBe(true);
    }
  });

  it("finds the known mutating surface (guards against a silently empty scan)", () => {
    // Raised from 20 when round 2 Task 10b widened the scan to private top-level
    // declarations: the real figure went from ~40 to 124, so a floor of 20 had
    // stopped being able to notice the scan half-collapsing.
    expect(enumerateMutatingSymbols().length).toBeGreaterThan(100);
  });

  it("has no two files contributing the same allowlist key", () => {
    // ALLOWLIST KEYS ARE `<basename>.<symbol>`, so two files with the same
    // basename and a same-named writer would share ONE key — and one
    // justification would silently excuse both, including a writer nobody
    // examined. There is no collision today (checked: 124 symbols, zero
    // duplicates), and the risk went UP rather than down with Task 10b's
    // widening: private helper names are shorter and more generic than exported
    // ones, and three listed files are called `worker.ts` while eleven are
    // called `service.ts`.
    //
    // A COLLISION IS NOT A FAILURE OF THIS SCHEME, it is a signal to re-key the
    // allowlist to full paths. This test exists so that decision is made
    // deliberately, the day it is forced, rather than being absorbed as a
    // duplicate entry that appears to work.
    const byKey = new Map<string, Set<string>>();
    for (const sym of enumerateMutatingSymbols()) {
      const key = `${basename(sym.file)}.${sym.name}`;
      byKey.set(key, (byKey.get(key) ?? new Set()).add(sym.file));
    }
    const collisions = [...byKey.entries()]
      .filter(([, files]) => files.size > 1)
      .map(([key, files]) => `${key} ← ${[...files].join(", ")}`);
    expect(collisions, `allowlist key collisions:\n${collisions.join("\n")}`).toEqual([]);
  });
});
