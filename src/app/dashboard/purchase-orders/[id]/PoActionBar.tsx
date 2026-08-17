"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Send, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { sendPoAction, cancelPoAction, closePoAction } from "./actions";
import { ReceiveStockDialog, type ReceiveDialogLine } from "./ReceiveStockDialog";
import { EnterInvoiceDialog } from "./EnterInvoiceDialog";
import type { PoStatus } from "@/server/purchasing/status";

export function PoActionBar({
  po,
}: {
  po: {
    id: string;
    status: PoStatus;
    poNumber: number;
    invoiceTotal?: string | null;
    lines: ReceiveDialogLine[];
  };
}) {
  const [pending, startTransition] = useTransition();

  function handleSend() {
    startTransition(async () => {
      const res = await sendPoAction(po.id);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(`PO #${po.poNumber} sent to supplier`);
    });
  }

  function handleCancel() {
    startTransition(async () => {
      const res = await cancelPoAction(po.id);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(`PO #${po.poNumber} cancelled`);
    });
  }

  function handleClose() {
    startTransition(async () => {
      const res = await closePoAction(po.id);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(`PO #${po.poNumber} closed`);
    });
  }

  const canSend = po.status === "draft";
  const canReceive = po.status === "sent" || po.status === "partially_received";
  const canInvoice = po.status === "sent" || po.status === "partially_received" || po.status === "received";
  const canClose = po.status === "received";
  const canCancel = po.status === "draft" || (po.status === "sent" && po.lines.every((l) => l.qtyReceived === 0));

  if (po.status === "closed" || po.status === "cancelled") {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canCancel && (
        <ConfirmActionButton
          title="Cancel Purchase Order"
          description={`Are you sure you want to cancel PO #${po.poNumber}? This action cannot be undone.`}
          confirmLabel="Yes, cancel PO"
          onConfirm={handleCancel}
          trigger={
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive hover:bg-destructive/10" disabled={pending}>
              <XCircle className="size-4 mr-1.5" /> Cancel PO
            </Button>
          }
        />
      )}

      {canSend && (
        <Button size="sm" onClick={handleSend} disabled={pending}>
          <Send className="size-4 mr-1.5" /> {pending ? "Sending..." : "Send to supplier"}
        </Button>
      )}

      {canReceive && (
        <ReceiveStockDialog poId={po.id} lines={po.lines} />
      )}

      {canInvoice && (
        <EnterInvoiceDialog poId={po.id} currentInvoiceTotal={po.invoiceTotal} />
      )}

      {canClose && (
        <ConfirmActionButton
          title="Close Purchase Order"
          description={`Close PO #${po.poNumber}? This marks the purchasing lifecycle as complete.`}
          confirmLabel="Close PO"
          onConfirm={handleClose}
          trigger={
            <Button size="sm" variant="default" disabled={pending}>
              <CheckCircle2 className="size-4 mr-1.5" /> Close PO
            </Button>
          }
        />
      )}
    </div>
  );
}
