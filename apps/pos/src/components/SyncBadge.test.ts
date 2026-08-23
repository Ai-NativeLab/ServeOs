import { describe, it, expect } from "vitest";
import type { SyncStatus } from "../../electron/preload";
import { badgeLabel, haltedSummary } from "./SyncBadge";

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({ state: "online", pending: 0, ...over });

describe("badgeLabel", () => {
  it("shows the four states verbatim, with the queue depth only on syncing", () => {
    expect(badgeLabel(status({ state: "online" }))).toBe("Online");
    expect(badgeLabel(status({ state: "offline" }))).toBe("Offline");
    expect(badgeLabel(status({ state: "halted" }))).toBe("Sync halted");
    expect(badgeLabel(status({ state: "syncing", pending: 3 }))).toBe("Syncing (3 queued)");
  });

  it("still reports a zero queue while syncing (the last batch's response is in flight)", () => {
    expect(badgeLabel(status({ state: "syncing", pending: 0 }))).toBe("Syncing (0 queued)");
  });
});

describe("haltedSummary", () => {
  it("is null when the queue is not halted", () => {
    expect(haltedSummary(status({ state: "online" }))).toBeNull();
    expect(haltedSummary(status({ state: "offline" }))).toBeNull();
  });

  it("names the stuck event's type and the server's refusal", () => {
    const s = status({
      state: "halted",
      haltedOn: { eventId: "e1", type: "cash.movement", error: "forbidden: a manager must approve this" },
    });
    expect(haltedSummary(s)).toBe("cash.movement — forbidden: a manager must approve this");
  });
});
