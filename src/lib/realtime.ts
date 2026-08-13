/**
 * The propagation contract, shared by the server publisher and every
 * subscriber (dashboard, storefront, POS main). One definition so an event
 * name or a topic can never drift between the two halves of the mechanism.
 */

export type TenantEventType = "orders.changed" | "sync.applied" | "stock.changed";

/** IDs only. A subscriber refetches through its own authenticated endpoint —
 *  entityIds is a hint about what moved, never data to render. */
export type TenantEvent = { type: TenantEventType; entityIds: string[] };

/**
 * Topics are PRIVATE. Joining `tenant:{uuid}` is authorized by an RLS policy
 * on `realtime.messages` against the tenant claim in the subscriber's token,
 * so an anon-key holder cannot listen to another tenant's topic. The publisher
 * must mark its messages the same way — a message published public is not
 * delivered to private joiners, and vice versa. Setup: docs/references/realtime.md.
 */
export const REALTIME_PRIVATE_TOPICS = true;

/** Everything a subscriber needs, minted server-side. The topic is handed
 *  over rather than rebuilt client-side, and the token is what the RLS policy
 *  reads — a client never picks its own tenant. */
export type TenantRealtimeConfig = {
  url: string;
  anonKey: string;
  topic: string;
  token: string;
};
