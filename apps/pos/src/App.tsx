import { useEffect, useState } from "react";
import { LoginScreen } from "./screens/LoginScreen";
import { OrderScreen } from "./screens/OrderScreen";
import { OrdersQueue } from "./screens/OrdersQueue";

type View = "order" | "queue";

export function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [branchName, setBranchName] = useState<string>("");
  const [view, setView] = useState<View>("order");

  useEffect(() => {
    window.pos.isPaired().then(async (p) => {
      setPaired(p);
      if (p) setBranchName(await window.pos.branchName());
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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 h-14">
        <div className="flex items-center gap-3">
          <span className="font-display text-base font-bold">Serve<span className="text-primary">OS</span> POS</span>
          <span className="text-sm text-muted-foreground">{branchName}</span>
        </div>
        <nav className="flex gap-1">
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
        </nav>
      </header>
      {view === "order" ? <OrderScreen branchName={branchName} /> : <OrdersQueue />}
    </div>
  );
}
