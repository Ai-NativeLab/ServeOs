import { useState } from "react";
import type { SyncStatus } from "../../electron/preload";

/** What the header badge shows for a status. Pure so it is testable without a
 *  render harness (this renderer has no established one — see SyncBadge.test.ts). */
export function badgeLabel(status: SyncStatus): string {
  if (status.state === "syncing") return `Syncing (${status.pending} queued)`;
  if (status.state === "offline") return "Offline";
  if (status.state === "halted") return "Sync halted";
  return "Online";
}

const DOT_CLASS: Record<SyncStatus["state"], string> = {
  online: "bg-status-ready",
  syncing: "bg-status-pending animate-pulse",
  offline: "bg-muted-foreground",
  halted: "bg-status-danger",
};

/** Small always-visible connectivity indicator. Never blocks anything itself
 *  — the halted STATE is what blocks, via SyncHaltedModal below. */
export function SyncBadge({ status }: { status: SyncStatus }) {
  return (
    <span
      title={status.lastError}
      className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[status.state]}`} />
      {badgeLabel(status)}
    </span>
  );
}

/** The halted alert's event summary — pure for the same testability reason
 *  as badgeLabel. Null when there is nothing to show (caller should not
 *  render the modal in that case). */
export function haltedSummary(status: SyncStatus): string | null {
  if (!status.haltedOn) return null;
  return `${status.haltedOn.type} — ${status.haltedOn.error}`;
}

const SUPPORT_EMAIL = "support@serveos.com";

function supportMailto(status: SyncStatus): string {
  const summary = haltedSummary(status) ?? "unknown";
  const body = `Till sync is halted.\n\nEvent: ${status.haltedOn?.eventId ?? "unknown"}\nDetails: ${summary}`;
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("POS sync halted")}&body=${encodeURIComponent(body)}`;
}

/**
 * Blocking: rendered as a full-screen overlay with no backdrop-dismiss, so an
 * operator cannot work around a halt by clicking past it — the queue really
 * is stuck (Task 10's sticky halt) and every event behind the failed one is
 * on hold until it is resolved. The only ways out are Retry succeeding — the
 * engine pushes state over `pos:syncState` as it changes (App.tsx's
 * subscription), so this modal unmounts itself the instant `state` leaves
 * `halted`, with no local "close" affordance — or a manual fix via support.
 */
export function SyncHaltedModal({ status }: { status: SyncStatus }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = haltedSummary(status);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const next = await window.pos.retryFailedSync();
      if (next.state === "halted") setError("Still halted — the server refused it again.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold text-ink">Sync halted</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The server refused an event and everything queued behind it is on hold. Nothing else on this till can
          sync until this is resolved.
        </p>
        {summary && (
          <p className="mt-3 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-status-danger-fg">
            {summary}
          </p>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-status-danger-fg">{error}</p>}
        <div className="mt-5 flex gap-2">
          <a
            href={supportMailto(status)}
            className="flex-1 rounded-xl border border-border bg-card px-4 py-3 text-center font-semibold text-ink"
          >
            Contact support
          </a>
          <button
            type="button"
            onClick={() => void retry()}
            disabled={busy}
            className="flex-1 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Retrying…" : "Retry"}
          </button>
        </div>
      </div>
    </div>
  );
}
