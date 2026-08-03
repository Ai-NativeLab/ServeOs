"use client";
import { useActionState } from "react";
import { customerUpdateProfileAction } from "./actions";

const input = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
const label = "mb-1 block text-xs font-medium text-muted-foreground";

export function ProfileForm({ name, phone, defaultAddressText }: {
  name: string; phone: string | null; defaultAddressText: string | null;
}) {
  const [state, action, pending] = useActionState(customerUpdateProfileAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <div><label className={label}>Name</label><input name="name" defaultValue={name} required className={input} /></div>
      <div><label className={label}>Phone</label><input name="phone" defaultValue={phone ?? ""} className={input} /></div>
      <div><label className={label}>Default delivery address</label>
        <textarea name="defaultAddressText" defaultValue={defaultAddressText ?? ""} rows={2} className={input} /></div>
      {state?.error && <p className="text-sm text-status-danger-fg">{state.error}</p>}
      {state?.saved && <p className="text-sm text-status-ready-fg">Saved.</p>}
      <button disabled={pending} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">
        {pending ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}
