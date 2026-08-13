"use client";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldError, FormError } from "@/components/forms/FieldError";
import { PASSWORD_MIN_LENGTH, SLUG_MAX_LENGTH, SLUG_MIN_LENGTH } from "@/lib/validation/fields";
import { registerAction, type RegisterState } from "./actions";
import { VERTICAL_IDS, VERTICAL_ACCENTS, type VerticalId } from "@/server/verticals";

const NAME_LABEL: Record<VerticalId, string> = {
  restaurant: "Restaurant name",
  retail: "Shop name",
  pharmacy: "Pharmacy name",
  timber: "Yard name",
};
const CARD_LABEL: Record<VerticalId, string> = {
  restaurant: "Restaurant",
  retail: "Retail",
  pharmacy: "Pharmacy",
  timber: "Timber",
};

const EMPTY: RegisterState = {};

export function RegisterForm() {
  const [vertical, setVertical] = useState<VerticalId>("restaurant");
  const accent = VERTICAL_ACCENTS[vertical];
  // The action returns its failures rather than throwing: a thrown error does
  // not survive the RSC boundary, and this form previously showed nothing at
  // all when registerTenant rejected a slug.
  const [state, formAction, pending] = useActionState(registerAction, EMPTY);
  const fieldError = (name: string) => state?.fieldErrors?.[name];
  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid grid-cols-2 gap-2">
        {VERTICAL_IDS.map((v) => {
          const active = v === vertical;
          return (
            <button
              type="button"
              key={v}
              onClick={() => setVertical(v)}
              className="rounded-md border px-3 py-2.5 text-[13px] font-semibold text-muted-foreground transition-colors"
              style={active ? { borderColor: accent, background: `${accent}1A`, color: accent } : undefined}
            >
              {CARD_LABEL[v]}
            </button>
          );
        })}
      </div>
      <input type="hidden" name="vertical" value={vertical} />

      <FormError message={state?.error} />

      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">{NAME_LABEL[vertical]}</span>
        <Input name="restaurantName" placeholder="Roma Ristorante" required maxLength={120} />
        <FieldError message={fieldError("restaurantName")} />
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Subdomain</span>
        <Input
          name="slug"
          placeholder="roma"
          required
          minLength={SLUG_MIN_LENGTH}
          maxLength={SLUG_MAX_LENGTH}
        />
        <span className="text-[11px] text-muted-foreground">
          Your storefront will be at roma.serveos.com
        </span>
        <FieldError message={fieldError("slug")} />
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Country</span>
        <select
          name="country"
          defaultValue="EG"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
        >
          <option value="EG">Egypt</option>
          <option value="SA">Saudi Arabia</option>
        </select>
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Your name</span>
        <Input name="ownerName" placeholder="Ahmed Hassan" required maxLength={120} />
        <FieldError message={fieldError("ownerName")} />
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Email</span>
        <Input name="email" type="email" required maxLength={254} />
        <FieldError message={fieldError("email")} />
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Password</span>
        <Input
          name="password"
          type="password"
          placeholder={`Min. ${PASSWORD_MIN_LENGTH} characters`}
          required
          minLength={PASSWORD_MIN_LENGTH}
        />
        <FieldError message={fieldError("password")} />
      </label>
      <Button
        type="submit"
        disabled={pending}
        className="mt-2 w-full text-white"
        style={{ background: accent, boxShadow: `0 16px 32px -16px ${accent}CC` }}
      >
        {pending ? "Creating…" : "Start free trial"}
      </Button>
    </form>
  );
}
