import { useEffect, useState } from "react";
import { LoginScreen } from "./screens/LoginScreen";
import { CashierSignIn } from "./screens/CashierSignIn";
import { OrderScreen } from "./screens/OrderScreen";
import { OrdersQueue } from "./screens/OrdersQueue";
import { HeldTickets } from "./screens/HeldTickets";
import type { CartLine } from "./order/cart";

type View = "order" | "queue" | "held";
export type Cashier = { name: string; permissions: string[] };
type RecalledDraft = { lines: CartLine[]; orderDiscount: number };

export function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [branchName, setBranchName] = useState<string>("");
  const [cashier, setCashier] = useState<Cashier | null>(null);
  const [view, setView] = useState<View>("order");
  const [recalled, setRecalled] = useState<RecalledDraft | null>(null);
  const [recallNonce, setRecallNonce] = useState(0);

  useEffect(() => {
    window.pos.isPaired().then(async (p) => {
      setPaired(p);
      if (p) {
        setBranchName(await window.pos.branchName());
        setCashier(await window.pos.cashier());
      }
    });
  }, []);

  if (paired === null) {
    return <div className="min-h-screen grid place-items-center bg-background text-sm text-muted-foreground">Loading…</div>;
  }

  if (!paired) {
    return (
      <LoginScreen
        onPaired={(name) => {
          setBranchName(name);
          setPaired(true);
        }}
      />
    );
  }

  if (!cashier) {
    return <CashierSignIn branchName={branchName} onSignedIn={setCashier} />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 h-14">
        <div className="flex items-center gap-3">
          <span className="font-display text-base font-bold">Serve<span className="text-primary">OS</span> POS</span>
          <span className="text-sm text-muted-foreground">{branchName}</span>
        </div>
        <nav className="flex items-center gap-1">
          <button
            onClick={() => setView("order")}
            className={view === "order"
              ? "rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground"
              : "rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary"}
          >
            Take order
          </button>
          <button
            onClick={() => setView("queue")}
            className={view === "queue"
              ? "rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground"
              : "rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary"}
          >
            Live orders
          </button>
          <button
            onClick={() => setView("held")}
            className={view === "held"
              ? "rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground"
              : "rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary"}
          >
            Parked
          </button>
          <button
            onClick={async () => { await window.pos.signOutCashier(); setCashier(null); }}
            className="ml-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary"
          >
            {cashier.name} · Sign out
          </button>
        </nav>
      </header>
      {view === "order" && (
        <OrderScreen
          key={recallNonce}
          branchName={branchName}
          cashier={cashier}
          recalled={recalled}
          onCartConsumed={() => setRecalled(null)}
        />
      )}
      {view === "queue" && <OrdersQueue />}
      {view === "held" && (
        <HeldTickets
          onRecall={(lines, orderDiscount) => {
            setRecalled({ lines, orderDiscount });
            setRecallNonce((n) => n + 1);
            setView("order");
          }}
        />
      )}
    </div>
  );
}
