"use client";
import { Button } from "@/components/ui/button";

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="grid place-items-center py-24 text-center">
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">This page failed to load. Try again.</p>
        <Button onClick={reset}>Retry</Button>
      </div>
    </div>
  );
}
