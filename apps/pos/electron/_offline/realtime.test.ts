import { describe, it, expect } from "vitest";
import {
  TenantSignal,
  type RealtimeEvent,
  type RealtimeTransport,
  type TenantEventType,
  type TenantRealtimeConfig,
} from "./realtime";

const CONFIG: TenantRealtimeConfig = {
  url: "https://proj.supabase.co",
  anonKey: "anon",
  topic: "tenant:t-1",
  token: "jwt",
};

/**
 * Records every join exactly as it was asked for, and lets a test drive the
 * channel's own callbacks — no socket, no Electron, no server.
 */
class FakeTransport implements RealtimeTransport {
  joins: { config: TenantRealtimeConfig; types: readonly TenantEventType[] }[] = [];
  closes = 0;
  private handlers: { onEvent(e: RealtimeEvent): void; onLive(live: boolean): void } | null = null;

  subscribe(
    config: TenantRealtimeConfig,
    types: readonly TenantEventType[],
    handlers: { onEvent(e: RealtimeEvent): void; onLive(live: boolean): void },
  ) {
    this.joins.push({ config, types });
    this.handlers = handlers;
    return { close: () => { this.closes++; } };
  }

  joined() { this.handlers?.onLive(true); }
  dropped() { this.handlers?.onLive(false); }
  broadcast(event: RealtimeEvent) { this.handlers?.onEvent(event); }
}

function makeSignal(overrides: Partial<{
  loadConfig(): Promise<TenantRealtimeConfig | null>;
  transport: FakeTransport;
}> = {}) {
  const transport = overrides.transport ?? new FakeTransport();
  const events: RealtimeEvent[] = [];
  const liveStates: boolean[] = [];
  const signal = new TenantSignal({
    loadConfig: overrides.loadConfig ?? (async () => CONFIG),
    transport,
    types: ["orders.changed", "sync.applied"],
    onEvent: (e) => events.push(e),
    onLive: (live) => liveStates.push(live),
  });
  return { signal, transport, events, liveStates };
}

describe("TenantSignal", () => {
  it("joins the tenant's topic once and forwards its ids-only events", async () => {
    const { signal, transport, events } = makeSignal();

    await signal.ensureConnected();
    await signal.ensureConnected(); // a second heartbeat must not open a second socket

    expect(transport.joins).toHaveLength(1);
    expect(transport.joins[0].config).toEqual(CONFIG);
    expect(transport.joins[0].types).toEqual(["orders.changed", "sync.applied"]);

    transport.broadcast({ type: "orders.changed", entityIds: ["o-1"] });
    expect(events).toEqual([{ type: "orders.changed", entityIds: ["o-1"] }]);
  });

  it("reports live only while the channel is joined", async () => {
    const { signal, transport, liveStates } = makeSignal();
    expect(signal.isLive()).toBe(false);

    await signal.ensureConnected();
    transport.joined();
    expect(signal.isLive()).toBe(true);

    transport.dropped();
    expect(signal.isLive()).toBe(false);
    expect(liveStates).toEqual([true, false]);
  });

  it("stays inert when the server has realtime switched off", async () => {
    const { signal, transport, liveStates } = makeSignal({ loadConfig: async () => null });

    await signal.ensureConnected();

    expect(transport.joins).toEqual([]);
    expect(signal.isLive()).toBe(false);
    expect(liveStates).toEqual([]);
  });

  it("swallows an unreachable server and retries on the next heartbeat", async () => {
    let attempts = 0;
    const transport = new FakeTransport();
    const { signal } = makeSignal({
      transport,
      loadConfig: async () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("network unreachable"), { isNetwork: true });
        return CONFIG;
      },
    });

    await signal.ensureConnected();
    expect(transport.joins).toHaveLength(0);

    await signal.ensureConnected();
    expect(transport.joins).toHaveLength(1);
  });

  it("closes the channel when the till goes offline, and reconnects after", async () => {
    const { signal, transport, liveStates } = makeSignal();
    await signal.ensureConnected();
    transport.joined();

    signal.disconnect();
    expect(transport.closes).toBe(1);
    expect(signal.isLive()).toBe(false);
    expect(liveStates).toEqual([true, false]);

    await signal.ensureConnected();
    expect(transport.joins).toHaveLength(2);
  });

  it("survives a disconnect it was never connected for", () => {
    const { signal, transport, liveStates } = makeSignal();
    signal.disconnect();
    signal.disconnect();
    expect(transport.closes).toBe(0);
    expect(liveStates).toEqual([]);
  });
});
