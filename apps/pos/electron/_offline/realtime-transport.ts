import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import type { RealtimeTransport } from "./realtime";

/**
 * The real Supabase socket, kept apart from `realtime.ts` so the signal's
 * logic stays testable without pulling a client library into the test run.
 *
 * Electron 33 runs Node 20, which has no global WebSocket, so the constructor
 * is handed over explicitly — without it the client refuses to connect at all.
 */
export function createRealtimeTransport(): RealtimeTransport {
  return {
    subscribe(config, types, handlers) {
      const client = createClient(config.url, config.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        // The device's tenant claim, which is what the RLS policy on
        // realtime.messages authorizes the private topic against.
        accessToken: async () => config.token,
        realtime: { transport: WebSocket as unknown as never },
      });
      const channel = client.channel(config.topic, { config: { private: true } });
      for (const type of types) {
        channel.on("broadcast", { event: type }, (message) => {
          const entityIds = (message.payload as { entityIds?: unknown })?.entityIds;
          handlers.onEvent({ type, entityIds: Array.isArray(entityIds) ? entityIds.map(String) : [] });
        });
      }
      channel.subscribe((status) => handlers.onLive(status === "SUBSCRIBED"));

      return {
        close() {
          void client.removeChannel(channel);
          void client.realtime.disconnect();
        },
      };
    },
  };
}
