"use client";
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";

export function StatusPoller({
  token, slug, initialStatus, steps, terminal, cancellable,
}: {
  token: string;
  slug: string;
  initialStatus: string;
  steps: string[];
  terminal: string[];
  cancellable: boolean;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const terminalRef = useRef(terminal);

  useEffect(() => {
    if (terminalRef.current.includes(status)) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/orders/${token}/status?slug=${encodeURIComponent(slug)}`);
        if (res.ok) {
          const data = await res.json();
          setStatus(data.status);
          if (terminalRef.current.includes(data.status)) clearInterval(id);
        }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(id);
  }, [token, slug, status]);

  async function cancel() {
    setCancelError(null);
    try {
      const res = await fetch(`/api/orders/${token}/cancel?slug=${encodeURIComponent(slug)}`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setStatus(data.status);
      } else if (data.code === "invalid_transition") {
        setCancelError("The restaurant has already confirmed this order — contact them directly to change it.");
        // re-sync to the true status
        const s = await fetch(`/api/orders/${token}/status?slug=${encodeURIComponent(slug)}`);
        if (s.ok) setStatus((await s.json()).status);
      } else {
        setCancelError(data.error ?? "Couldn't cancel the order.");
      }
    } catch {
      setCancelError("Network error — please try again.");
    }
  }

  const label = (s: string) => s.replace(/_/g, " ");
  const currentIdx = steps.indexOf(status);
  const failed = status === "cancelled" || status === "rejected";

  return (
    <div className="mt-6">
      {failed ? (
        <div className="card-lift rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3.5 text-center font-sans font-semibold capitalize text-destructive">
          {label(status)}
        </div>
      ) : (
        <div className="card-lift rounded-2xl border border-border bg-card p-5">
          <ol className="space-y-0">
            {steps.map((s, i) => {
              const isDone = i < currentIdx;
              const isCurrent = i === currentIdx;
              const isLast = i === steps.length - 1;
              return (
                <li key={s} className="relative flex gap-3 pb-6 last:pb-0">
                  {!isLast && (
                    <span
                      aria-hidden
                      className={`absolute left-[9px] top-5 -bottom-1 w-0.5 transition-colors ${
                        isDone ? "bg-primary" : "bg-border"
                      }`}
                    />
                  )}
                  <span
                    className={`relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                      isDone
                        ? "border-primary bg-primary"
                        : isCurrent
                          ? "border-primary bg-background ring-4 ring-primary/15"
                          : "border-border bg-background"
                    }`}
                  >
                    {isDone ? (
                      <Check className="size-3 text-primary-foreground" strokeWidth={3} />
                    ) : isCurrent ? (
                      <span className="size-2 rounded-full bg-primary" />
                    ) : null}
                  </span>
                  <span
                    className={`text-sm capitalize ${
                      isCurrent ? "font-display font-bold text-ink" : isDone ? "text-ink" : "text-muted-foreground"
                    }`}
                  >
                    {label(s)}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {cancellable && status === "pending" && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              className="mt-4 rounded-full border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/5"
            >
              Cancel order
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
              <AlertDialogDescription>
                This can't be undone. You can only cancel while the restaurant hasn't confirmed yet.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep order</AlertDialogCancel>
              <AlertDialogAction onClick={cancel}>Cancel order</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {cancelError && <p className="mt-2 text-sm text-destructive">{cancelError}</p>}
    </div>
  );
}
