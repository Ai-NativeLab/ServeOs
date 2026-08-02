export type InboundEvent =
  | { kind: "text"; text: string }
  | { kind: "interactive"; replyId: string }
  | { kind: "location"; lat: number; lng: number }
  | { kind: "unsupported" };

export type InboundMessage = {
  phoneNumberId: string;
  waId: string;
  profileName: string | null;
  providerMessageId: string;
  /** Meta's unix seconds. Used to drop out-of-order replays. */
  timestamp: number;
  event: InboundEvent;
};

export type StatusUpdate = { providerMessageId: string; status: string };

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function toEvent(m: Record<string, unknown>): InboundEvent {
  const type = m.type;
  if (type === "text") {
    const body = (m.text as { body?: string } | undefined)?.body;
    return typeof body === "string" ? { kind: "text", text: body } : { kind: "unsupported" };
  }
  if (type === "interactive") {
    const i = m.interactive as { list_reply?: { id?: string }; button_reply?: { id?: string } } | undefined;
    // Key off the stable id. Titles are localized and truncated to 24 chars.
    const id = i?.list_reply?.id ?? i?.button_reply?.id;
    return typeof id === "string" ? { kind: "interactive", replyId: id } : { kind: "unsupported" };
  }
  if (type === "location") {
    const l = m.location as { latitude?: number; longitude?: number } | undefined;
    if (typeof l?.latitude === "number" && typeof l?.longitude === "number") {
      return { kind: "location", lat: l.latitude, lng: l.longitude };
    }
    return { kind: "unsupported" };
  }
  return { kind: "unsupported" };
}

/**
 * Flattens Meta's entry[].changes[].value shape.
 *
 * A single POST may batch many entries — including entries belonging to
 * DIFFERENT tenants — so every level is iterated. Status callbacks arrive on the
 * same endpoint as customer messages and are separated here so they can never
 * reach conversation state.
 */
export function parseWebhook(payload: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  const root = (payload ?? {}) as { entry?: unknown };

  for (const entry of asArray(root.entry)) {
    for (const change of asArray((entry as { changes?: unknown }).changes)) {
      const value = (change as { value?: Record<string, unknown> }).value ?? {};
      const phoneNumberId = (value.metadata as { phone_number_id?: string } | undefined)?.phone_number_id;
      if (!phoneNumberId) continue;

      for (const s of asArray(value.statuses)) {
        const st = s as { id?: string; status?: string };
        if (st.id && st.status) statuses.push({ providerMessageId: st.id, status: st.status });
      }

      const contacts = asArray(value.contacts) as { profile?: { name?: string }; wa_id?: string }[];
      for (const raw of asArray(value.messages)) {
        const m = raw as Record<string, unknown>;
        const from = m.from as string | undefined;
        const id = m.id as string | undefined;
        if (!from || !id) continue;
        const contact = contacts.find((c) => c.wa_id === from) ?? contacts[0];
        messages.push({
          phoneNumberId,
          waId: from,
          profileName: contact?.profile?.name ?? null,
          providerMessageId: id,
          timestamp: Number(m.timestamp ?? 0),
          event: toEvent(m),
        });
      }
    }
  }
  return { messages, statuses };
}
