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
import { SyncBadge, SyncHaltedModal } from "./components/SyncBadge";
import type { CartLine } from "./order/cart";
import type { SyncStatus } from "../electron/preload";

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
  // Task 11: currentShift() answers from local state (Task 10) — nothing here
  // is a network call, so there is nothing worth gating the whole shell
  // behind. Default to the safe assumption (closed: cash tenders stay
  // refused until this is confirmed open) and correct it the moment the
  // local read comes back, typically within one render.
  const [hasOpenShift, setHasOpenShift] = useState(false);
  const [skippedDrawer, setSkippedDrawer] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    window.pos.isPaired().then(async (p) => {
      setPaired(p);
      if (p) {
        setBranchName(await window.pos.branchName());
        setCashier(await window.pos.cashier());
      }
    });
  }, []);

  // Primed once from the current value, then kept live by the engine's push
  // (pos:syncState) — the badge and the halt alert never poll for it.
  useEffect(() => {
    window.pos.syncState().then(setSyncStatus);
    return window.pos.onSyncState(setSyncStatus);
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

  // Computed once and appended to whichever screen below actually renders:
  // a halt can be sitting in the queue from a PRIOR session (the engine comes
  // back up halted on restart — sync.ts's constructor) before a cashier ever
  // signs in this session, so the alert must not be reachable only from the
  // main tabbed shell — it has to block every screen past pairing.
  const haltedModal = syncStatus?.state === "halted" ? <SyncHaltedModal status={syncStatus} /> : null;

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
    return (
      // The halt modal rides along from here on: a sync halt left over from a
      // previous session must be visible before a cashier signs back in, not
      // hidden behind the sign-in and drawer screens.
      <>
        <CashierSignIn
          branchName={branchName}
          onSignedIn={setCashier}
          onUnpaired={() => {
            setPaired(false);
            setCashier(null);
          }}
        />
        {haltedModal}
      </>
    );
  }
  // No "Checking the drawer…" gate: hasOpenShift starts false and is corrected
  // by a local read, so boot never waits on the network.

  // Offered, not forced: card-only selling is legitimate without a drawer, and
  // the server refuses cash when there is none.
  if (!hasOpenShift && !skippedDrawer) {
    return (
      <>
        <OpenDrawerScreen
          branchName={branchName}
          onOpened={() => setHasOpenShift(true)}
          onSkip={() => setSkippedDrawer(true)}
        />
        {haltedModal}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 h-14">
        <div className="flex items-center gap-3">
          <span className="font-display text-base font-bold">Serve<span className="text-primary">OS</span> POS</span>
          <span className="text-sm text-muted-foreground">{branchName}</span>
          {!hasOpenShift && <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-muted-foreground">No drawer</span>}
          {syncStatus && <SyncBadge status={syncStatus} />}
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
              setHasOpenShift(false);
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
      {view === "queue" && <OrdersQueue offline={syncStatus?.state === "offline"} />}
      {view === "history" && <SalesHistory offline={syncStatus?.state === "offline"} />}
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

      {/* Blocking: the queue is stuck behind a refused event (Task 10's sticky
       *  halt) — every tab above is still mounted underneath, but this overlay
       *  is the only thing the operator can interact with until it resolves. */}
      {haltedModal}
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
