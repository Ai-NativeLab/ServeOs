import type { Plan, PlanFeatures, PlanLimits } from "@/server/subscription";
import type { Locale } from "@/shared/errors";
import { PRICING } from "../_content/pricing";

/**
 * The full limits and features grid — the detail the home page's cards cannot
 * show well, and the reason a dedicated pricing page earns its keep.
 *
 * Every value is read off the same `plan` rows PlanCard renders, never from
 * copy, so the table cannot end up contradicting the cards when a plan changes.
 *
 * A zero limit renders as an em dash, not "0". PlanCard filters those out
 * because "0 WhatsApp numbers" is not a benefit, and a comparison grid is the
 * easiest place to reintroduce that mistake.
 */
export function PlanComparison({ plans, locale }: { plans: Plan[]; locale: Locale }) {
  const t = PRICING[locale];
  // A row that is an em dash in every column compares nothing — the seeded
  // plans all have reservations off, which rendered a whole row of "—".
  const limitKeys = (Object.keys(t.limits) as (keyof PlanLimits)[])
    .filter((k) => plans.some((p) => p.limits[k] > 0));
  const featureKeys = (Object.keys(t.features) as (keyof PlanFeatures)[])
    .filter((k) => plans.some((p) => p.features[k]));
  const nf = new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en");

  return (
    // Five columns do not fit a phone. The table scrolls inside this container
    // so the page body itself never scrolls sideways.
    <div className="mt-14 overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <caption className="sr-only">{t.heading}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="p-3 text-start font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
            >
              {t.eyebrow}
            </th>
            {plans.map((p) => (
              <th key={p.id} scope="col" className="p-3 text-start text-base font-bold tracking-[-0.01em]">
                {t.planNames[p.key] ?? p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {limitKeys.map((key) => (
            <tr key={key} className="border-t border-border/60">
              <th scope="row" className="p-3 text-start font-normal text-muted-foreground">
                {t.limits[key]}
              </th>
              {plans.map((p) => (
                <td key={p.id} className="p-3 tabular-nums">
                  {p.limits[key] > 0 ? nf.format(p.limits[key]) : "—"}
                </td>
              ))}
            </tr>
          ))}
          {featureKeys.map((key) => (
            <tr key={key} className="border-t border-border/60">
              <th scope="row" className="p-3 text-start font-normal text-muted-foreground">
                {t.features[key]}
              </th>
              {plans.map((p) => (
                <td key={p.id} className="p-3">
                  {p.features[key] ? (
                    <span style={{ color: "var(--trade-accent)" }} aria-hidden="true">✓</span>
                  ) : (
                    <span aria-hidden="true">—</span>
                  )}
                  <span className="sr-only">
                    {p.features[key] ? t.features[key] : `${t.features[key]} —`}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
