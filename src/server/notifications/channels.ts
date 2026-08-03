import type { db } from "@/db/client";
import { notifications, notificationOutbox } from "./schema";
import type { NotifyEvent, NotifyTarget } from "./service";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A target after resolution: role targets carry the concrete users holding
 *  the role. Future channels extend this shape (WhatsApp adds waId) without
 *  touching notify()'s callers. */
export type Recipient = { userId: string; email: string | null };

export type DeliverArgs = {
  tx: Tx;
  tenantId: string;
  event: NotifyEvent;
  /** The caller's targets, verbatim — for channels that store role rows as-is. */
  targets: NotifyTarget[];
  /** Role targets expanded to concrete users (deduped), with their emails. */
  recipients: Recipient[];
  replyTo: string | null;
};

/**
 * THE NotificationProvider surface (spec §Decisions, issue #63's blocker):
 * one channel = one way a NotifyEvent reaches a human. in_app and email ship
 * here; SMS / WhatsApp / push implement this same interface and register in
 * CHANNELS — notify()'s callers never change.
 */
export interface NotificationChannel {
  readonly key: "in_app" | "email";
  deliver(args: DeliverArgs): Promise<void>;
}

/** The in-app feed: ONE row per caller target. A role row is stored once with
 *  targetRole — the feed query matches it to every holder at read time. */
const inAppChannel: NotificationChannel = {
  key: "in_app",
  async deliver({ tx, tenantId, event, targets }) {
    if (targets.length === 0) return;
    await tx.insert(notifications).values(targets.map((t) => ({
      tenantId,
      userId: "userId" in t ? t.userId : null,
      targetRole: "role" in t ? t.role : null,
      type: event.type,
      severity: event.severity,
      title: event.title,
      body: event.body,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
    })));
  },
};

/** The outbox: one row per resolved recipient WITH an address. A user without
 *  an email is skipped, never an error — the in-app row still reaches them. */
const emailChannel: NotificationChannel = {
  key: "email",
  async deliver({ tx, tenantId, event, recipients, replyTo }) {
    const rows = recipients
      .filter((r): r is Recipient & { email: string } => r.email !== null)
      .map((r) => ({
        tenantId,
        toEmail: r.email,
        replyTo,
        subject: event.title,
        template: event.emailTemplate ?? event.type,
        payload: event.emailPayload ?? {},
      }));
    if (rows.length === 0) return;
    await tx.insert(notificationOutbox).values(rows);
  },
};

export const CHANNELS: Record<"in_app" | "email", NotificationChannel> = {
  in_app: inAppChannel,
  email: emailChannel,
};
