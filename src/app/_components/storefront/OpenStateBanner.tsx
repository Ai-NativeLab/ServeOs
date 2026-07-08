import type { BranchOpenState } from "@/server/branches/slots";

export function OpenStateBanner({ state, paused }: { state: BranchOpenState; paused: boolean }) {
  if (paused) {
    return (
      <div className="border-b border-border bg-muted px-4 py-2.5 text-sm text-muted-foreground sm:px-6">
        Not taking orders right now.
      </div>
    );
  }
  if (state.open) {
    if (!state.closesAt) return null;
    return (
      <div className="border-b border-border bg-background px-4 py-2.5 text-sm text-muted-foreground sm:px-6">
        Open · closes {state.closesAt}
      </div>
    );
  }
  return (
    <div className="border-b border-border bg-primary/10 px-4 py-2.5 text-sm font-medium text-ink sm:px-6">
      Closed{state.opensAt ? ` · pre-order for when we open at ${state.opensAt}` : " · pre-orders welcome"}
    </div>
  );
}
