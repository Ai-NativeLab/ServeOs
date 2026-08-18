import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { listPlans } from "@/server/subscription";
import type { Locale } from "@/shared/errors";
import { Faq } from "../../_components/Faq";
import { Footer } from "../../_components/Footer";
import { Header } from "../../_components/Header";
import { PaperSurface } from "../../_components/PaperSurface";
import { PlanComparison } from "../../_components/PlanComparison";
import { PricingTerms } from "../../_components/PricingTerms";
import { PRICING } from "../../_content/pricing";

function toLocale(lang: string): Locale {
  if (lang !== "ar" && lang !== "en") notFound();
  return lang;
}

const META: Record<Locale, { title: string; description: string }> = {
  ar: {
    title: "أسعار ServeOS — باقات بالجنيه المصري",
    description:
      "باقات ServeOS بالجنيه المصري: الحدود والمميزات لكل باقة، من غير مفاجآت. أقل مدة اشتراك ثلاثة شهور.",
  },
  en: {
    title: "ServeOS pricing — plans in Egyptian pounds",
    description:
      "Every ServeOS plan, its limits and its features, priced in EGP. Three-month minimum term.",
  },
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const locale = toLocale((await params).lang);
  const site = "https://serveos.tech";
  return {
    title: META[locale].title,
    description: META[locale].description,
    alternates: {
      canonical: locale === "ar" ? `${site}/pricing` : `${site}/en/pricing`,
      languages: { ar: `${site}/pricing`, en: `${site}/en/pricing` },
    },
  };
}

/**
 * The public pricing page.
 *
 * It exists because "send me your pricing" needs a link to send, and the home
 * page's section is not one. It reuses PricingTerms and PlanCard rather than
 * restating any figure, so this page and the home section read the same plan
 * rows and can never quote different numbers.
 *
 * There is deliberately no payment-mechanism section: nothing is paid for on
 * this site, so describing a checkout would invent a flow the product does not
 * have — the same mistake as advertising an unshipped feature.
 */
export default async function PricingPage({ params }: { params: Promise<{ lang: string }> }) {
  const locale = toLocale((await params).lang);

  // Same guard as the home page: /pricing is a marketing surface only, never
  // reachable on a tenant or admin host.
  const surface = (await headers()).get("x-surface");
  if (surface !== "marketing") notFound();

  // listPlans() has no isActive predicate, so filter here rather than change a
  // shared service the admin console also calls. isActive is a text column.
  const plans = (await listPlans()).filter((p) => p.isActive === "true");
  const t = PRICING[locale];

  return (
    <PaperSurface>
      <Header locale={locale} path="/pricing" />
      <main>
        <section id="pricing" className="mx-auto max-w-6xl px-6 py-20">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {t.eyebrow}
          </p>
          <h1 className="mt-4 max-w-2xl text-4xl font-bold leading-tight tracking-[-0.03em]">
            {t.heading}
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-7 text-muted-foreground">{t.note}</p>

          <PricingTerms plans={plans} locale={locale} />
          <PlanComparison plans={plans} locale={locale} />
        </section>

        <Faq content={t.faq} id="pricing-faq" />
      </main>
      <Footer locale={locale} path="/pricing" />
    </PaperSurface>
  );
}
