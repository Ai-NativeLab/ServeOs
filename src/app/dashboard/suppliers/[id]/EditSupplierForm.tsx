"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { updateSupplierAction } from "../actions";
import type { Supplier } from "@/server/purchasing/schema";

const selectCls = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function EditSupplierForm({ supplier }: { supplier: Supplier }) {
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(supplier.name);
  const [contactName, setContactName] = useState(supplier.contactName ?? "");
  const [email, setEmail] = useState(supplier.email ?? "");
  const [phone, setPhone] = useState(supplier.phone ?? "");
  const [paymentTerms, setPaymentTerms] = useState(supplier.paymentTerms ?? "");
  const [notes, setNotes] = useState(supplier.notes ?? "");
  const [isActive, setIsActive] = useState(supplier.isActive);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Supplier name is required");
      return;
    }

    startTransition(async () => {
      const res = await updateSupplierAction(supplier.id, {
        name: name.trim(),
        contactName: contactName.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        paymentTerms: paymentTerms.trim() || null,
        notes: notes.trim() || null,
        isActive,
      });

      if ("error" in res) {
        toast.error(res.error);
        return;
      }

      toast.success("Supplier details updated");
    });
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="s-name">Company Name</Label>
            <Input
              id="s-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-status">Status</Label>
            <select
              id="s-status"
              className={selectCls}
              value={isActive ? "active" : "inactive"}
              onChange={(e) => setIsActive(e.target.value === "active")}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="s-contact">Contact Person</Label>
            <Input
              id="s-contact"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="e.g. Ahmed Ali"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-email">Email (for sending POs)</Label>
            <Input
              id="s-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="orders@supplier.example"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-phone">Phone</Label>
            <Input
              id="s-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+20 ..."
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="s-terms">Payment Terms</Label>
            <Input
              id="s-terms"
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
              placeholder="e.g. Net 30, COD"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-notes">Notes</Label>
            <Input
              id="s-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Internal vendor notes"
            />
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
