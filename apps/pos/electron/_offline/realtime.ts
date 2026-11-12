/**
 * The till's ear on its tenant's Realtime topic.
 *
 * Main owns this, like every other socket the app has: the renderer gets a
 * signal over IPC and never learns the Supabase url, key or token. The signal
 * is IDs-only and is never rendered — the queue refetches through the same
 * authenticated endpoint it polls, so a broadcast can only make the till ask
 * earlier, never tell it something the server would not have.
 */

export type TenantEventType = "orders.changed" | "sync.applied" | "stock.changed";

/** Minted per device by the server (`GET /api/pos/v1/realtime`), from the
 *  paired device's own tenant — the till never names a topic itself. */
export type TenantRealtimeConfig = {
  url: string;
  anonKey: string;
  topic: string;
  token: string;
};

export type RealtimeEvent = { type: TenantEventType; entityIds: string[] };

/** Closing must be safe to call twice — a drop and a shutdown can race. */
export type RealtimeSubscription = { close(): void };

/**
 * Injected rather than constructed so the signal is testable without Electron,
 * a socket, or a server (`createRealtimeTransport` builds the real one).
 */
export interface RealtimeTransport {
  subscribe(
    config: TenantRealtimeConfig,
    types: readonly TenantEventType[],
    handlers: { onEvent(event: RealtimeEvent): void; onLive(live: boolean): void },
  ): RealtimeSubscription;
}

export type TenantSignalOptions = {
  /** Null when the server has realtime switched off — then this whole object
   *  is inert and the queue keeps its normal poll. */
  loadConfig(): Promise<TenantRealtimeConfig | null>;
  transport: RealtimeTransport;
  types: readonly TenantEventType[];
  onEvent(event: RealtimeEvent): void;
  onLive(live: boolean): void;
};

/**
 * Connects while the till has a network and lets go when it doesn't. There is
 * no retry timer of its own: `ensureConnected` is idempotent and the sync
 * engine's existing heartbeat drives it, so a reconnect costs nothing extra
 * and an outage cannot leave a half-open channel behind.
 */
export class TenantSignal {
  private subscription: RealtimeSubscription | null = null;
  private connecting = false;
  private live = false;

  constructor(private readonly opts: TenantSignalOptions) {}

  isLive(): boolean {
    return this.live;
  }

  async ensureConnected(): Promise<void> {
    if (this.subscription || this.connecting) return;
    this.connecting = true;
    try {
      const config = await this.opts.loadConfig();
      // No config (realtime unconfigured, or the device token was refused)
      // is not an error: the till simply keeps polling.
      if (!config) return;
      this.subscription = this.opts.transport.subscribe(config, this.opts.types, {
        onEvent: (event) => this.opts.onEvent(event),
        onLive: (live) => this.setLive(live),
      });
    } catch {
      /* offline, or the server said no — the next heartbeat tries again */
    } finally {
      this.connecting = false;
    }
  }

  /** Dropped deliberately (went offline, app quitting). The socket would die
   *  with the network anyway; closing it keeps `live` honest for the queue. */
  disconnect(): void {
    const sub = this.subscription;
    this.subscription = null;
    this.setLive(false);
    sub?.close();
  }

  private setLive(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    this.opts.onLive(live);
  }
}
