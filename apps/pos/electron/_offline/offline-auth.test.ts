import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "./db";
import { Store, type AuthUser } from "./store";
// The server's own hasher, not a local fixture — a hand-rolled hash here
// would only prove this file agrees with itself. Hashing with the real
// hashPassword and verifying with offlineSignIn is the actual parity proof
// the task requires: a cashier who can sign in online must be able to sign
// in offline against the exact same stored hash, and vice versa.
import { hashPassword } from "../../../../src/server/auth/password";
import {
  offlineSignIn,
  offlineGrant,
  consumeOfflineGrant,
  createGrantVault,
  type OfflineGrantVault,
} from "./offline-auth";

function makeStore(): Store {
  return new Store(openDb(":memory:"));
}

async function roster(overrides: Partial<AuthUser> = {}, password = "pw123"): Promise<AuthUser> {
  return {
    userId: "11111111-1111-1111-1111-111111111111",
    name: "Cass Cashier",
    email: "c@x.com",
    passwordHash: await hashPassword(password),
    permissions: ["pos:sell"],
    ...overrides,
  };
}

describe("offlineSignIn — scrypt parity with the server", () => {
  it("verifies a cached cashier offline using the server's own hash", async () => {
    const store = makeStore();
    const cashier = await roster();
    store.saveAuthRoster([cashier], "2026-08-13T00:00:00Z");

    const session = offlineSignIn(store, "c@x.com", "pw123");
    expect(session?.permissions).toContain("pos:sell");
    expect(session?.userId).toBe(cashier.userId);
    expect(session?.name).toBe("Cass Cashier");

    expect(offlineSignIn(store, "c@x.com", "wrong")).toBeNull();
  });

  it("two hashes of the same password (different salts) both verify", async () => {
    // Guards against a fixed-salt bug: the server mints a fresh salt per
    // hashPassword call, so a correct implementation must not assume salts
    // are interchangeable across users.
    const store = makeStore();
    const a = await roster({ userId: "u-a", email: "a@x.com" }, "shared-pw");
    const b = await roster({ userId: "u-b", email: "b@x.com" }, "shared-pw");
    expect(a.passwordHash).not.toBe(b.passwordHash);
    store.saveAuthRoster([a, b], "t1");

    expect(offlineSignIn(store, "a@x.com", "shared-pw")?.userId).toBe("u-a");
    expect(offlineSignIn(store, "b@x.com", "shared-pw")?.userId).toBe("u-b");
  });

  it("returns null for an email with no roster match, and appends nothing", async () => {
    const store = makeStore();
    store.saveAuthRoster([await roster()], "t1");

    expect(offlineSignIn(store, "nobody@x.com", "pw123")).toBeNull();
    expect(store.pendingEvents()).toHaveLength(0);
  });

  it("appends session.signed_in on a successful sign-in, naming the actor", async () => {
    const store = makeStore();
    const cashier = await roster();
    store.saveAuthRoster([cashier], "t1");

    offlineSignIn(store, "c@x.com", "pw123");

    const events = store.pendingEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session.signed_in");
    expect(JSON.parse(events[0].payload)).toEqual({ actorUserId: cashier.userId, outcome: "success" });
  });

  it("appends session.signed_in for a failed attempt too, so it isn't lost to the outage", async () => {
    const store = makeStore();
    const cashier = await roster();
    store.saveAuthRoster([cashier], "t1");

    offlineSignIn(store, "c@x.com", "wrong");

    const events = store.pendingEvents();
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({ actorUserId: cashier.userId, outcome: "failed" });
  });

  it("never writes the password or its hash into the appended event payload", async () => {
    const store = makeStore();
    const cashier = await roster();
    store.saveAuthRoster([cashier], "t1");

    offlineSignIn(store, "c@x.com", "pw123");

    const raw = store.pendingEvents()[0].payload;
    expect(raw).not.toContain("pw123");
    expect(raw).not.toContain(cashier.passwordHash.split(":")[1]);
  });
});

describe("offlineGrant — manager authorization from the synced roster", () => {
  const CASHIER_ID = "22222222-2222-2222-2222-222222222222";
  let store: Store;
  let vault: OfflineGrantVault;
  let manager: AuthUser;

  beforeEach(async () => {
    store = makeStore();
    vault = createGrantVault();
    manager = await roster(
      { userId: "33333333-3333-3333-3333-333333333333", email: "m@x.com", permissions: ["pos:sell", "reconciliation:manage"] },
      "mgr-pw",
    );
    store.saveAuthRoster([manager], "t1");
  });

  it("requires an authorizer who actually holds the permission", () => {
    const denied = offlineGrant(store, vault, CASHIER_ID, "m@x.com", "mgr-pw", "pos:refund");
    expect(denied).toBeNull();
    expect(store.pendingEvents()).toHaveLength(0);
  });

  it("grants when the authorizer holds the permission, appending grant.issued and returning a token", () => {
    const grant = offlineGrant(store, vault, CASHIER_ID, "m@x.com", "mgr-pw", "reconciliation:manage");
    expect(grant?.authorizedByUserId).toBe(manager.userId);
    expect(grant?.token).toMatch(/^[0-9a-f]{48}$/);

    const events = store.pendingEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("grant.issued");
    expect(JSON.parse(events[0].payload)).toEqual({
      actorUserId: CASHIER_ID,
      authorizedByUserId: manager.userId,
      permission: "reconciliation:manage",
    });
  });

  it("rejects a wrong authorizer password, appending nothing", () => {
    const denied = offlineGrant(store, vault, CASHIER_ID, "m@x.com", "wrong", "reconciliation:manage");
    expect(denied).toBeNull();
    expect(store.pendingEvents()).toHaveLength(0);
  });

  it("rejects an authorizer email with no roster match", () => {
    const denied = offlineGrant(store, vault, CASHIER_ID, "nobody@x.com", "mgr-pw", "reconciliation:manage");
    expect(denied).toBeNull();
  });

  it("rejects a permission string the server would not recognize", () => {
    const denied = offlineGrant(store, vault, CASHIER_ID, "m@x.com", "mgr-pw", "not:a:real:permission");
    expect(denied).toBeNull();
    expect(store.pendingEvents()).toHaveLength(0);
  });

  it("the returned token is single-use — a second consume for the same token fails", () => {
    const grant = offlineGrant(store, vault, CASHIER_ID, "m@x.com", "mgr-pw", "reconciliation:manage")!;

    expect(consumeOfflineGrant(vault, grant.token, "reconciliation:manage")).toBe(manager.userId);
    expect(consumeOfflineGrant(vault, grant.token, "reconciliation:manage")).toBeNull();
  });

  it("consuming a token against the wrong permission fails, and still burns the token", () => {
    const grant = offlineGrant(store, vault, CASHIER_ID, "m@x.com", "mgr-pw", "reconciliation:manage")!;

    expect(consumeOfflineGrant(vault, grant.token, "pos:refund")).toBeNull();
    expect(consumeOfflineGrant(vault, grant.token, "reconciliation:manage")).toBeNull(); // already burned
  });

  it("consuming an unknown token fails", () => {
    expect(consumeOfflineGrant(vault, "not-a-real-token", "reconciliation:manage")).toBeNull();
  });
});
