"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  REALTIME_PRIVATE_TOPICS,
  type TenantEvent,
  type TenantEventType,
  type TenantRealtimeConfig,
} from "./realtime";

/** How long a poller may wait once the socket is carrying the news. Still a
 *  real interval, not "never": it is the net under a silently dead channel. */
export const RELAXED_POLL_MS = 60_000;

/**
 * Subscribes to this tenant's private Realtime topic and calls `onEvent` for
 * every matching broadcast. Returns whether the channel is actually joined —
 * callers relax their polling ONLY while that is true, so an unconfigured,
 * unreachable or unauthorized Realtime degrades to today's cadence rather than
 * to a slower one.
 *
 * `config` is minted server-side (src/server/realtime/token.ts): a page that
 * cannot mint it passes null and this hook does nothing at all. The payloads
 * are ids; the caller's job is to refetch through its own authenticated
 * endpoint, never to render what arrived here.
 *
 * `enabled` is for a page that has nothing left to hear about — a finished
 * order — and wants its socket back.
 */
export function useTenantEvents(
  config: TenantRealtimeConfig | null,
  types: readonly TenantEventType[],
  onEvent: (event: TenantEvent) => void,
  enabled = true,
): boolean {
  const [live, setLive] = useState(false);
  // Read through a ref so an inline handler (the common case) does not tear
  // the socket down and rebuild it on every render.
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  // Pinned at mount. A server re-render (router.refresh, a navigation back)
  // mints a fresh token, and following it would tear the channel down and
  // rebuild it exactly when the page is busiest. The channel simply ends when
  // the token does; the next full page load starts a new one.
  const [pinned] = useState(config);
  const url = pinned?.url;
  const anonKey = pinned?.anonKey;
  const topic = pinned?.topic;
  const token = pinned?.token;
  const eventNames = types.join(",");

  useEffect(() => {
    if (!enabled || !url || !anonKey || !topic || !token) return;

    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      // The tenant claim in this token is what the RLS policy on
      // realtime.messages authorizes the topic against.
      accessToken: async () => token,
    });
    const channel = client.channel(topic, { config: { private: REALTIME_PRIVATE_TOPICS } });
    for (const type of eventNames.split(",") as TenantEventType[]) {
      channel.on("broadcast", { event: type }, (message) => {
        const entityIds = (message.payload as { entityIds?: unknown })?.entityIds;
        handler.current({ type, entityIds: Array.isArray(entityIds) ? entityIds.map(String) : [] });
      });
    }
    channel.subscribe((status) => setLive(status === "SUBSCRIBED"));

    return () => {
      setLive(false);
      // Both halves: removeChannel only unsubscribes, and a socket left open
      // by an unmounted page still counts against the connection budget.
      void client.removeChannel(channel);
      void client.realtime.disconnect();
    };
  }, [enabled, url, anonKey, topic, token, eventNames]);

  return live;
}
