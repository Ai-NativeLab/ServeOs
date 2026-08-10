import { useCallback, useEffect, useState } from "react";
import { LoginScreen } from "./screens/LoginScreen";
import { CashierSignIn } from "./screens/CashierSignIn";
import { OrderScreen } from "./screens/OrderScreen";
import { OrdersQueue } from "./screens/OrdersQueue";
import { SalesHistory } from "./screens/SalesHistory";
import { HeldTickets } from "./screens/HeldTickets";
import { DrawerScreen } from "./screens/DrawerScreen";
import { OpenDrawerScreen } from "./screens/OpenDrawerScreen";
import { XReportScreen } from "./screens/XReport";
import { ZReportScreen } from "./screens/ZReport";
import type { CartLine } from "./order/cart";

type View = "order" | "queue" | "held" | "drawer" | "reports" | "history";
export type Cashier = { name: string; permissions: string[] };
type RecalledDraft = { lines: CartLine[]; orderDiscount: number };

const TABS: { view: View; label: string }[] = [
  { view: "order", label: "Take order" },
  { view: "queue", label: "Live orders" },
  { view: "history", label: "History" },
  { view: "held", label: "Parked" },
  { view: "drawer", label: "Drawer" },
  { view: "reports", label: "Reports" },
];

export function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [branchName, setBranchName] = useState<string>("");
  const [cashier, setCashier] = useState<Cashier | null>(null);
  const [view, setView] = useState<View>("order");
  const [recalled, setRecalled] = useState<RecalledDraft | null>(null);
  const [recallNonce, setRecallNonce] = useState(0);
  // null while we have not asked the server yet — the drawer prompt must not
  // flash before we know whether one is already open.
  const [hasOpenShift, setHasOpenShift] = useState<boolean | null>(null);
  const [skippedDrawer, setSkippedDrawer] = useState(false);

  useEffect(() => {
    window.pos.isPaired().then(async (p) => {
      setPaired(p);
      if (p) {
        setBranchName(await window.pos.branchName());
        setCashier(await window.pos.cashier());
      }
    });
  }, []);

  const refreshShift = useCallback(async () => {
    const { shift } = await window.pos.currentShift();
    setHasOpenShift(Boolean(shift));
  }, []);

  // A drawer belongs to the till, not the person — but each cashier taking over
  // should be told where it stands, so we re-read on sign-in. Resetting on
  // sign-OUT happens in the handler below, where the event actually occurs.
  useEffect(() => {
    if (!cashier) return;
    window.pos.currentShift().then(({ shift }) => setHasOpenShift(Boolean(shift)));
  }, [cashier]);

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

  if (hasOpenShift === null) {
    return <div className="min-h-screen grid place-items-center bg-background text-sm text-muted-foreground">Checking the drawer…</div>;
  }

  // Offered, not forced: card-only selling is legitimate without a drawer, and
  // the server refuses cash when there is none.
  if (!hasOpenShift && !skippedDrawer) {
    return (
      <OpenDrawerScreen
        branchName={branchName}
        onOpened={() => setHasOpenShift(true)}
        onSkip={() => setSkippedDrawer(true)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 h-14">
        <div className="flex items-center gap-3">
          <span className="font-display text-base font-bold">Serve<span className="text-primary">OS</span> POS</span>
          <span className="text-sm text-muted-foreground">{branchName}</span>
          {!hasOpenShift && <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-muted-foreground">No drawer</span>}
        </div>
        <nav className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.view}
              onClick={() => setView(tab.view)}
              className={view === tab.view
                ? "rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground"
                : "rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary"}
            >
              {tab.label}
            </button>
          ))}
          <button
            onClick={async () => {
              await window.pos.signOutCashier();
              setCashier(null);
              setHasOpenShift(null);
              setSkippedDrawer(false);
            }}
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
          hasOpenShift={hasOpenShift}
          onNeedDrawer={() => setView("drawer")}
          recalled={recalled}
          onCartConsumed={() => setRecalled(null)}
        />
      )}
      {view === "queue" && <OrdersQueue />}
      {view === "history" && <SalesHistory />}
      {view === "held" && (
        <HeldTickets
          onRecall={(lines, orderDiscount) => {
            setRecalled({ lines, orderDiscount });
            setRecallNonce((n) => n + 1);
            setView("order");
          }}
        />
      )}
      {view === "drawer" && <DrawerScreen branchName={branchName} onChanged={refreshShift} />}
      {view === "reports" && <ReportsTab />}
    </div>
  );
}

/** X is the peek, Z is the close — two screens, one toggle. */
function ReportsTab() {
  const [kind, setKind] = useState<"x" | "z">("x");
  return (
    <div className="px-4">
      <div className="mx-auto mt-6 flex w-full max-w-xl items-center gap-1 rounded-lg bg-secondary p-1">
        {(["x", "z"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={
              kind === k
                ? "flex-1 rounded-md bg-card px-3 py-1.5 text-sm font-semibold text-ink shadow-sm"
                : "flex-1 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground"
            }
          >
            {k === "x" ? "X report — mid-shift" : "Z report — close"}
          </button>
        ))}
      </div>
      {kind === "x" ? <XReportScreen /> : <ZReportScreen />}
    </div>
  );
}
