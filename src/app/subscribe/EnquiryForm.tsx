"use client";
import { useActionState } from "react";
import type { Locale } from "@/shared/errors";
import { PRICING } from "../(marketing)/_content/pricing";
import { submitEnquiryAction, type EnquiryState } from "./actions";

/**
 * Where a paid plan leads. Paid plans are sales-assisted — there is no card
 * checkout — so this collects enough to call the prospect back and nothing more.
 */
export function EnquiryForm({ planKey, locale }: { planKey: string; locale: Locale }) {
  const t = PRICING[locale];
  const planName = t.planNames[planKey] ?? planKey;
  const [state, action, pending] = useActionState<EnquiryState | null, FormData>(
    submitEnquiryAction,
    null,
  );

  if (state?.ok) {
    return (
      <section className="mx-auto max-w-md px-6 py-20">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">{t.enquiry.heading}</h1>
        <p className="mt-4 text-sm leading-7">{t.enquiry.success}</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-md px-6 py-20">
      <h1 className="text-2xl font-bold tracking-[-0.02em]">{t.enquiry.heading}</h1>
      <p className="mt-2 text-sm font-bold" style={{ color: "var(--trade-accent)" }}>{planName}</p>
      <p className="mt-4 text-sm leading-7 text-muted-foreground">{t.enquiry.intro}</p>

      <form action={action} className="mt-8 grid gap-4">
        <input type="hidden" name="plan" value={planKey} />
        <input type="hidden" name="locale" value={locale} />
        {/* Honeypot: hidden from people, irresistible to bots. */}
        <input
          type="text"
          name="company"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="hidden"
        />

        <label className="grid gap-1 text-sm">
          {t.enquiry.name}
          <input name="name" required className="rounded-md border border-border bg-transparent px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm">
          {t.enquiry.businessName}
          <input name="businessName" required className="rounded-md border border-border bg-transparent px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm">
          {t.enquiry.phone}
          <input name="phone" required inputMode="tel" className="rounded-md border border-border bg-transparent px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm">
          {t.enquiry.email}
          <input name="email" required type="email" className="rounded-md border border-border bg-transparent px-3 py-2" />
        </label>

        {state?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error === "tooSoon" ? t.enquiry.tooSoon : t.enquiry.failed}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="mt-2 rounded-md border border-border px-4 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
        >
          {t.enquiry.submit}
        </button>
      </form>
    </section>
  );
}
