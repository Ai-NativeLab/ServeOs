import { useEffect, useState } from "react";

type SyncState = "online" | "offline" | "syncing";

export function SyncBanner() {
  const [state, setState] = useState<SyncState>("online");
  const [pending, setPending] = useState(0);

  useEffect(() => {
    window.pos.onState((s, p) => {
      setState(s);
      setPending(p);
    });
  }, []);

  if (state === "online") return null;

  const label = state === "syncing" ? "Syncing…" : "Offline";
  return (
    <div
      className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-status-pending-fg bg-status-pending/30 border-b border-border"
      role="status"
    >
      <span className="inline-block h-2 w-2 rounded-full bg-status-pending" />
      <span>{label}</span>
      {pending > 0 && <span className="text-muted-foreground">· {pending} pending</span>}
    </div>
  );
}
