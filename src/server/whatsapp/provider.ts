import type { WhatsappAccount } from "./schema";

export type ListRow = { id: string; title: string; description?: string };
export type Button = { id: string; title: string };

export type OutboundMessage =
  | { kind: "text"; body: string }
  | { kind: "buttons"; body: string; buttons: Button[] }
  | { kind: "list"; body: string; button: string; rows: ListRow[] };

/** Meta's hard limits. Exported so the renderer and the providers agree. */
export const LIST_MAX_ROWS = 10;
export const ROW_TITLE_MAX = 24;
export const ROW_DESC_MAX = 72;
export const BUTTON_MAX = 3;
export const BUTTON_TITLE_MAX = 20;

/** Throws if `msg` would be rejected by Meta. Shared by every provider. */
export function assertSendable(msg: OutboundMessage): void {
  if (msg.kind === "list") {
    // 10 rows TOTAL across all sections — sections group, they do not add capacity.
    if (msg.rows.length > LIST_MAX_ROWS) throw new Error(`list exceeds ${LIST_MAX_ROWS} rows`);
    for (const r of msg.rows) {
      if (r.title.length > ROW_TITLE_MAX) throw new Error(`row title exceeds ${ROW_TITLE_MAX} chars: ${r.title}`);
      if (r.description && r.description.length > ROW_DESC_MAX) throw new Error(`row description exceeds ${ROW_DESC_MAX} chars`);
    }
  }
  if (msg.kind === "buttons") {
    if (msg.buttons.length > BUTTON_MAX) throw new Error(`more than ${BUTTON_MAX} buttons`);
    for (const b of msg.buttons) {
      if (b.title.length > BUTTON_TITLE_MAX) throw new Error(`button title exceeds ${BUTTON_TITLE_MAX} chars`);
    }
    const labels = new Set(msg.buttons.map((b) => b.title));
    if (labels.size !== msg.buttons.length) throw new Error("button labels must be unique");
  }
}

export interface WhatsAppProvider {
  /** Returns the provider message id (wamid) of the sent message. */
  send(account: WhatsappAccount, waId: string, msg: OutboundMessage): Promise<string>;
}
