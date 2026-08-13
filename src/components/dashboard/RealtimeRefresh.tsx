"use client";
import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { TenantEventType, TenantRealtimeConfig } from "@/lib/realtime";
import { useTenantEvents } from "@/lib/realtime-client";

/**
 * Keeps a server-rendered page fresh without giving it a poller of its own.
 * A matching broadcast re-runs the page on the server (`router.refresh()`),
 * which re-reads through the same session and RLS the first render used — the
 * ids in the payload are never trusted for anything.
 *
 * Unconfigured realtime means this renders nothing and changes nothing: the
 * page keeps refreshing on navigation and its own server actions, as today.
 */
const COALESCE_MS = 300;

export function RealtimeRefresh({ config, types }: {
  config: TenantRealtimeConfig | null;
  types: TenantEventType[];
}) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A batch that lands as several events must cost one server render, not one
  // per event.
  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => router.refresh(), COALESCE_MS);
  }, [router]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useTenantEvents(config, types, refresh);
  return null;
}
