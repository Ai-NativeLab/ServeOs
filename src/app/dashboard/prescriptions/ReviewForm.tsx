"use client";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { reviewPrescriptionAction } from "./actions";

export function ReviewForm({ prescriptionId }: { prescriptionId: string }) {
  const [state, action, pending] = useActionState(reviewPrescriptionAction, undefined);
  const [rejecting, setRejecting] = useState(false);

  return (
    <div className="space-y-2">
      {!rejecting ? (
        <div className="flex items-center gap-2">
          <form action={action}>
            <input type="hidden" name="prescriptionId" value={prescriptionId} />
            <input type="hidden" name="approved" value="true" />
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Recording…" : "Approve"}
            </Button>
          </form>
          <Button variant="outline" size="sm" onClick={() => setRejecting(true)} disabled={pending}>
            Reject
          </Button>
        </div>
      ) : (
        <form action={action} className="space-y-2">
          <input type="hidden" name="prescriptionId" value={prescriptionId} />
          <input type="hidden" name="approved" value="false" />
          <textarea
            name="reason" required rows={2}
            placeholder="Why is this being rejected? The customer sees this."
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <div className="flex items-center gap-2">
            <Button type="submit" variant="destructive" size="sm" disabled={pending}>
              {pending ? "Recording…" : "Confirm rejection"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRejecting(false)}>Cancel</Button>
          </div>
        </form>
      )}
      {state?.error && <p className="text-sm text-status-danger-fg">{state.error}</p>}
    </div>
  );
}
