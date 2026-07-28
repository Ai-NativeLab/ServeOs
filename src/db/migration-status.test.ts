import { describe, it, expect } from "vitest";
import {
  compareMigrations, isUnreachable, formatMigrationStatus, readJournal,
  type MigrationEntry,
} from "./migration-status";

const entry = (idx: number, when: number, hash: string): MigrationEntry => ({
  idx, when, hash, tag: `${String(idx).padStart(4, "0")}_m${idx}`,
});

describe("compareMigrations", () => {
  it("reports everything applied when disk and ledger agree", () => {
    const entries = [entry(0, 100, "a"), entry(1, 200, "b")];
    const status = compareMigrations(entries, [
      { hash: "a", createdAt: 100 },
      { hash: "b", createdAt: 200 },
    ]);

    expect(status.applied.map((e) => e.hash)).toEqual(["a", "b"]);
    expect(status.pending).toEqual([]);
    expect(status.orphans).toEqual([]);
    expect(status.watermark).toBe(200);
  });

  it("reports a migration that was never applied as pending", () => {
    const entries = [entry(0, 100, "a"), entry(1, 200, "b")];
    const status = compareMigrations(entries, [{ hash: "a", createdAt: 100 }]);

    expect(status.pending.map((e) => e.hash)).toEqual(["b"]);
  });

  it("catches the real failure: an out-of-order ledger row hiding an earlier migration", () => {
    // 0016 (when=200) never ran, but another branch's migration landed at 300,
    // pushing the watermark past it — exactly the shape that broke the dashboard.
    const entries = [entry(15, 100, "a"), entry(16, 200, "skipped"), entry(17, 400, "c")];
    const status = compareMigrations(entries, [
      { hash: "a", createdAt: 100 },
      { hash: "from-another-branch", createdAt: 300 },
      { hash: "c", createdAt: 400 },
    ]);

    expect(status.pending.map((e) => e.hash)).toEqual(["skipped"]);
    expect(status.orphans).toEqual([{ hash: "from-another-branch", createdAt: 300 }]);
    expect(isUnreachable(status.pending[0], status.watermark)).toBe(true);
  });

  it("treats a pending migration newer than the watermark as merely not-yet-run", () => {
    const entries = [entry(0, 100, "a"), entry(1, 500, "next")];
    const status = compareMigrations(entries, [{ hash: "a", createdAt: 100 }]);

    // This one drizzle WILL apply on the next run — it is not stuck.
    expect(isUnreachable(status.pending[0], status.watermark)).toBe(false);
  });

  it("handles an empty ledger — a fresh database", () => {
    const entries = [entry(0, 100, "a")];
    const status = compareMigrations(entries, []);

    expect(status.pending).toHaveLength(1);
    expect(status.watermark).toBeNull();
    expect(isUnreachable(status.pending[0], status.watermark)).toBe(false);
  });
});

describe("formatMigrationStatus", () => {
  it("calls an unreachable migration out and names the repair command", () => {
    const status = compareMigrations(
      [entry(16, 200, "skipped")],
      [{ hash: "other", createdAt: 300 }],
    );
    const report = formatMigrationStatus(status);

    expect(report).toContain("UNREACHABLE");
    expect(report).toContain("npm run db:repair");
    expect(report).toContain("0016_m16");
  });

  it("says so plainly when nothing is outstanding", () => {
    const status = compareMigrations([entry(0, 100, "a")], [{ hash: "a", createdAt: 100 }]);
    expect(formatMigrationStatus(status)).toContain("every migration on disk has been applied");
  });
});

describe("readJournal", () => {
  it("reads this repo's own journal and hashes every migration file", () => {
    const entries = readJournal("drizzle");

    expect(entries.length).toBeGreaterThan(0);
    // Indices ascend and every entry carries a real sha256.
    expect(entries.map((e) => e.idx)).toEqual([...entries.map((e) => e.idx)].sort((a, b) => a - b));
    for (const e of entries) expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
