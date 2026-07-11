import { Clock, PauseCircle } from "lucide-react";
import type { BranchOpenState } from "@/server/branches/slots";

export function OpenStateBanner({ state, paused }: { state: BranchOpenState; paused: boolean }) {
  if (paused) {
    return (
      <div className="flex items-center gap-2.5 border-b border-border bg-muted px-4 py-2.5 text-sm text-muted-foreground sm:px-6">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
          <PauseCircle className="size-3.5" strokeWidth={1.75} />
        </span>
        Not taking orders right now.
      </div>
    );
  }
  if (state.open) {
    if (!state.closesAt) return null;
    return (
      <div className="flex items-center gap-2.5 border-b border-border bg-muted px-4 py-2.5 text-sm text-muted-foreground sm:px-6">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-status-ready/15 text-status-ready-fg">
          <Clock className="size-3.5" strokeWidth={1.75} />
        </span>
        Open · closes {state.closesAt}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 border-b border-border bg-accent px-4 py-2.5 text-sm font-medium text-ink sm:px-6">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background/70 text-primary">
        <Clock className="size-3.5" strokeWidth={1.75} />
      </span>
      Closed{state.opensAt ? ` · pre-order for when we open at ${state.opensAt}` : " · pre-orders welcome"}
    </div>
  );
}
