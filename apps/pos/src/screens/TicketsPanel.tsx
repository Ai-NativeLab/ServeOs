import { useEffect, useState } from "react";

type Ticket = {
  client_order_id: string;
  status: string;
  order_number: string | null;
};

function statusLabel(t: Ticket): string {
  if (t.status === "synced" && t.order_number) return `Synced #${t.order_number}`;
  if (t.status === "failed") return "Failed";
  return "Pending";
}

function statusClass(t: Ticket): string {
  if (t.status === "synced") return "text-status-ready-fg";
  if (t.status === "failed") return "text-status-danger-fg";
  return "text-status-pending-fg";
}

export function TicketsPanel({ refreshKey }: { refreshKey: number }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.pos
      .getTickets()
      .then((t) => {
        if (!cancelled) setTickets(t);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const interval = setInterval(() => {
      window.pos.getTickets().then((t) => {
        if (!cancelled) setTickets(t);
      });
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshKey]);

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <h2 className="text-sm font-semibold text-ink mb-2">Recent tickets</h2>
      {loading && tickets.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tickets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tickets yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tickets.map((t) => (
            <li key={t.client_order_id} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground font-mono truncate">
                {t.order_number ? `#${t.order_number}` : t.client_order_id.slice(0, 8)}
              </span>
              <span className={`font-medium ${statusClass(t)}`}>{statusLabel(t)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
