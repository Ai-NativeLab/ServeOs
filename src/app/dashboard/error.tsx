"use client";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/brand/LogoMark";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // BEST-EFFORT net (#172): production strips server-error messages down to a
  // digest before they reach this client boundary, so this heuristic can miss
  // an UnauthorizedError thrown by a server component in prod. The real gate
  // is server-side: every dashboard PAGE authorizes through a require*Permission
  // wrapper whose refusal is a redirect to /dashboard/denied, which production
  // cannot strip. Only actions and API routes may use the throwing authorize().
  // If a permission refusal reaches this boundary as a crash in production,
  // some page is calling authorize() inline — move it onto a wrapper.
  const isUnauthorized =
    error?.name === "UnauthorizedError" ||
    error?.message?.toLowerCase().includes("unauthorized") ||
    error?.message?.toLowerCase().includes("permission") ||
    error?.message?.toLowerCase().includes("forbidden");

  if (isUnauthorized) {
    return (
      <div className="grid place-items-center py-20 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-status-pending/10 text-status-pending mb-4 mx-auto">
          <ShieldAlert className="size-6" />
        </div>
        <h2 className="font-display text-lg font-bold text-ink">Permission required</h2>
        <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
          {error?.message && error.message !== "UnauthorizedError"
            ? error.message
            : "You do not have permission to view this page. Contact your administrator if you need access."}
        </p>
        <div className="mt-6">
          <Button asChild variant="outline">
            <Link href="/dashboard/orders">Back to Dashboard →</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid place-items-center py-24 text-center">
      <div className="space-y-3">
        <LogoMark className="size-10 text-muted-foreground/40 mx-auto" />
        <h2 className="font-display text-lg font-bold text-ink">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">This page failed to load. Try again.</p>
        <Button onClick={reset}>Retry</Button>
      </div>
    </div>
  );
}
