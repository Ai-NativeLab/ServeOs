"use client";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { setTradeApprovalAction } from "./actions";

export function TradeApprovalForm({ customerId, tradeApproved, tradeDiscountPercent }: {
  customerId: string; tradeApproved: boolean; tradeDiscountPercent: string | null;
}) {
  const [state, action, pending] = useActionState(setTradeApprovalAction, undefined);
  const [percent, setPercent] = useState(tradeDiscountPercent ?? "10");

  if (tradeApproved) {
    return (
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="customerId" value={customerId} />
        <input type="hidden" name="approved" value="false" />
        <span className="font-mono text-xs text-status-ready-fg">{tradeDiscountPercent}% trade</span>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>Revoke</Button>
        {state?.error && <span className="text-xs text-status-danger-fg">{state.error}</span>}
      </form>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="approved" value="true" />
      <input
        name="discountPercent" type="number" min={0} max={100} value={percent}
        onChange={(e) => setPercent(e.target.value)}
        className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs"
      />
      <span className="text-xs text-muted-foreground">%</span>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>Approve trade</Button>
      {state?.error && <span className="text-xs text-status-danger-fg">{state.error}</span>}
    </form>
  );
}
