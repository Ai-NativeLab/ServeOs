"use client";
import { useActionState } from "react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { generatePairingCodeAction } from "./actions";

type Branch = { id: string; name: string };

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

type Result =
  | { code: string; expiresAt: Date }
  | { error: string }
  | undefined;

export function PairingForm({ branches }: { branches: Branch[] }) {
  const [state, formAction, pending] = useActionState<Result, FormData>(
    async (_prev, formData) => {
      try {
        return await generatePairingCodeAction(formData);
      } catch (err) {
        unstable_rethrow(err);
        return { error: "Something went wrong. Please try again." };
      }
    },
    undefined,
  );

  if (state && "error" in state) toast.error(state.error);

  return (
    <div>
      <form action={formAction} className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="branchId">Branch</Label>
          <select id="branchId" name="branchId" required className={selectClass} defaultValue="">
            <option value="" disabled>Select a branch</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="label">Device label</Label>
          <Input id="label" name="label" required placeholder="e.g. Front counter" />
        </div>
        <Button type="submit" disabled={pending} className="w-fit">
          {pending ? "Generating…" : "Generate pairing code"}
        </Button>
      </form>

      {state && "code" in state && (
        <div className="mt-5 rounded-lg border border-primary/40 bg-primary/5 p-5 text-center">
          <p className="eyebrow text-primary mb-2">Pairing code (expires in 10 minutes)</p>
          <p className="font-mono text-4xl font-bold tracking-[0.3em] text-ink">{state.code}</p>
          <p className="text-xs text-muted-foreground mt-2">
            Enter this code in the POS app to pair the device.
          </p>
        </div>
      )}
    </div>
  );
}
