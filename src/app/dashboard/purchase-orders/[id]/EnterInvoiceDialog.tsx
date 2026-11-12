"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { enterInvoiceAction } from "./actions";

export function EnterInvoiceDialog({
  poId,
  currentInvoiceTotal,
}: {
  poId: string;
  currentInvoiceTotal?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [amount, setAmount] = useState(currentInvoiceTotal ? String(Number(currentInvoiceTotal)) : "");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const val = parseFloat(amount);
    if (isNaN(val) || val < 0) {
      toast.error("Enter a valid positive invoice total");
      return;
    }

    startTransition(async () => {
      const res = await enterInvoiceAction(poId, val);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }

      toast.success("Invoice total recorded");
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Receipt className="size-4 mr-1.5" />
          {currentInvoiceTotal ? "Update invoice" : "Enter invoice"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Supplier invoice total</DialogTitle>
            <DialogDescription>
              Enter the gross billed amount from the supplier&apos;s invoice to calculate the three-way variance.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="invoiceAmount">Invoice total amount (gross)</Label>
              <div className="relative">
                <Input
                  id="invoiceAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="font-mono text-base pr-12"
                  autoFocus
                />
                <span className="absolute right-3 top-2.5 text-xs font-semibold text-muted-foreground">
                  EGP
                </span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Record invoice"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
