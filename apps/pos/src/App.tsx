import { useEffect, useState } from "react";
import { SyncBanner } from "./components/SyncBanner";
import { PairScreen } from "./screens/PairScreen";
import { OrderScreen } from "./screens/OrderScreen";

export function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [branchName, setBranchName] = useState<string>("");

  useEffect(() => {
    window.pos.isPaired().then((p) => setPaired(p));
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SyncBanner />
      {paired === null ? (
        <div className="grid place-items-center py-20 text-sm text-muted-foreground">Loading…</div>
      ) : paired ? (
        <OrderScreen branchName={branchName} />
      ) : (
        <PairScreen
          onPaired={(name) => {
            setBranchName(name);
            setPaired(true);
          }}
        />
      )}
    </div>
  );
}
