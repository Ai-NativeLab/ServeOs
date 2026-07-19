import { useEffect, useState } from "react";
import type { CartLine } from "../order/cart";

type Ticket = { id: string; label: string; draftJson: unknown; createdAt: string };
type Draft = { lines: CartLine[]; orderDiscount?: number };

export function HeldTickets({ onRecall }: { onRecall: (lines: CartLine[], orderDiscount: number) => void }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setTickets(await window.pos.listHeldTickets());
    setLoading(false);
  }

  useEffect(() => {
    window.pos.listHeldTickets().then((ts) => {
      setTickets(ts);
      setLoading(false);
    });
  }, []);

  async function recall(t: Ticket) {
    const draft = t.draftJson as Draft;
    await window.pos.discardTicket(t.id);
    onRecall(draft.lines ?? [], draft.orderDiscount ?? 0);
  }

  async function discard(id: string) {
    await window.pos.discardTicket(id);
    await refresh();
  }

  if (loading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading parked tickets…</p>;
  }

  if (tickets.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No parked tickets.</p>;
  }

  return (
    <ul className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
      {tickets.map((t) => (
        <li key={t.id} className="rounded-2xl border border-border bg-card p-4">
          <p className="font-semibold text-ink">{t.label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {new Date(t.createdAt).toLocaleString()}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => recall(t)}
              className="flex-1 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
            >
              Recall
            </button>
            <button
              onClick={() => discard(t.id)}
              className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground"
            >
              Discard
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
