"use client";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/brand/LogoMark";

/**
 * Shared fallback for the console's per-route error boundaries. `retry` must be
 * wired to the boundary's `unstable_retry` — it re-fetches the failed segment,
 * unlike `reset`, which only clears the boundary and re-renders the same
 * failed data. Production omits the server message, so the digest is the only
 * handle on what actually failed; show it.
 */
export function AdminError({
  error,
  retry,
}: {
  error?: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    if (error) console.error("[admin] render failed:", error);
  }, [error]);

  return (
    <div className="grid place-items-center py-24 text-center">
      <div className="space-y-3">
        <LogoMark className="size-10 text-muted-foreground/40 mx-auto" />
        <h2 className="font-display text-lg font-bold text-ink">
          Something went wrong
        </h2>
        <p className="text-sm text-muted-foreground">
          This page failed to load. Try again.
        </p>
        {error?.digest && (
          <p className="text-xs text-muted-foreground">
            Reference: <code className="font-mono">{error.digest}</code>
          </p>
        )}
        <Button onClick={() => retry()}>Retry</Button>
      </div>
    </div>
  );
}
