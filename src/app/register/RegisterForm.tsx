"use client";
import { useActionState, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { registerAction } from "./actions";
import { MIN_PASSWORD_LENGTH, type RegisterField, type RegisterState } from "./registration-form";
import { SLUG_PATTERN, SLUG_RULE } from "@/server/onboarding/slug";
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

function Field({
  label,
  name,
  error,
  hint,
  children,
}: {
  label: string;
  name: RegisterField;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {error ? (
        <span id={`${name}-error`} role="alert" className="text-[11px] text-destructive">
          {error}
        </span>
      ) : hint ? (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

/** aria wiring for an input whose Field may be showing an error. */
const invalid = (state: RegisterState | null, name: RegisterField) =>
  state?.errors[name] ? { "aria-invalid": true, "aria-describedby": `${name}-error` } : {};

export function RegisterForm({ plan, rootDomain }: { plan?: string; rootDomain: string }) {
  const [state, action, pending] = useActionState(registerAction, null);
  const [vertical, setVertical] = useState<VerticalId>("restaurant");
  // Controlled and lowercased as typed: phone keyboards capitalise the first
  // letter, and the preview below should show the address they will get.
  const [slug, setSlug] = useState("");
  const accent = VERTICAL_ACCENTS[vertical];
  const values = state?.values;

  return (
    <form action={action} className="grid gap-4">
      {/* Carried from the pricing flow so billing opens on the plan they chose.
          Already validated against the plans table by the page. */}
      {plan ? <input type="hidden" name="plan" value={plan} /> : null}
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

      <Field label={NAME_LABEL[vertical]} name="restaurantName" error={state?.errors.restaurantName}>
        <Input name="restaurantName" placeholder="Roma Ristorante" defaultValue={values?.restaurantName} required {...invalid(state, "restaurantName")} />
      </Field>
      <Field
        label="Subdomain"
        name="slug"
        error={state?.errors.slug}
        hint={<>Your storefront will be at {slug || "roma"}.{rootDomain}</>}
      >
        <Input
          name="slug"
          placeholder="roma"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          pattern={SLUG_PATTERN}
          title={SLUG_RULE}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          {...invalid(state, "slug")}
        />
      </Field>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Country</span>
        <select
          name="country"
          defaultValue={values?.country ?? "EG"}
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
        >
          <option value="EG">Egypt</option>
          <option value="SA">Saudi Arabia</option>
        </select>
      </label>
      <Field label="Your name" name="ownerName" error={state?.errors.ownerName}>
        <Input name="ownerName" placeholder="Ahmed Hassan" autoComplete="name" defaultValue={values?.ownerName} required {...invalid(state, "ownerName")} />
      </Field>
      <Field label="Email" name="email" error={state?.errors.email}>
        <Input name="email" type="email" autoComplete="email" defaultValue={values?.email} required {...invalid(state, "email")} />
      </Field>
      <Field label="Password" name="password" error={state?.errors.password}>
        <Input
          name="password"
          type="password"
          placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          required
          {...invalid(state, "password")}
        />
      </Field>
      <Button
        type="submit"
        disabled={pending}
        className="mt-2 w-full text-white"
        style={{ background: accent, boxShadow: `0 16px 32px -16px ${accent}CC` }}
      >
        {pending ? "Creating your store…" : "Start free trial"}
      </Button>
    </form>
  );
}
