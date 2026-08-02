"use client";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/brand/LogoMark";

/**
 * Admin-wide error boundary. Sits above the `(console)` route group so it
 * covers the console layout as well as its pages — `error.tsx` does not wrap
 * the layout in its own segment.
 *
 * Production omits the server message, so the digest is the only handle on what
 * actually failed; show it rather than making someone open the host's logs.
 */
export default function AdminError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[admin] render failed:", error);
  }, [error]);

  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div className="space-y-3">
        <LogoMark className="size-10 text-muted-foreground/40 mx-auto" />
        <h2 className="font-display text-lg font-bold text-ink">Admin console failed to load</h2>
        <p className="text-sm text-muted-foreground">
          This is a server-side fault, not a sign-in problem.
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground">
            Reference: <code className="font-mono">{error.digest}</code>
          </p>
        )}
        <div className="flex items-center justify-center gap-2 pt-1">
          <Button onClick={() => unstable_retry()}>Retry</Button>
          <Button variant="outline" asChild>
            <a href="/admin/login">Back to sign in</a>
          </Button>
        </div>
      </div>
    </div>
  );
}
