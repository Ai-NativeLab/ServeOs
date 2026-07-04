"use client";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/brand/LogoMark";

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
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
