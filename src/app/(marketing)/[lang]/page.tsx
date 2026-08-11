import { Suspense } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { listPlans } from "@/server/subscription";
import type { Locale } from "@/shared/errors";
import { ClosingCta } from "../_components/ClosingCta";
import { DemoBand } from "../_components/DemoBand";
import { Faq } from "../_components/Faq";
import { FeatureGrid } from "../_components/FeatureGrid";
import { Footer } from "../_components/Footer";
import { Header } from "../_components/Header";
import { Hero } from "../_components/Hero";
import { MotionReveal } from "../_components/MotionReveal";
import { Outcomes } from "../_components/Outcomes";
import { PaperSurface } from "../_components/PaperSurface";
import { PhotoBand } from "../_components/PhotoBand";
import { Pricing } from "../_components/Pricing";
import { Steps } from "../_components/Steps";
import { Story } from "../_components/Story";
import { SurfaceTour } from "../_components/SurfaceTour";
import { TradeBand } from "../_components/TradeBand";
import { TradeProvider } from "../_components/TradeProvider";

function toLocale(lang: string): Locale {
  if (lang !== "ar" && lang !== "en") notFound();
  return lang;
}

const META: Record<Locale, { title: string; description: string }> = {
  ar: {
    title: "ServeOS — نظام واحد للمحل: طلبات، كاشير، وواتساب",
    description:
      "قائمتك أونلاين، والطلبات من الطاولة ومن واتساب ومن متجرك — كلها في لوحة تحكم واحدة. بالعربي وبالجنيه المصري.",
  },
  en: {
    title: "ServeOS — one system for orders, counter and WhatsApp",
    description:
      "Your menu online and orders from the table, WhatsApp and your storefront in one dashboard. Arabic-first, priced in EGP.",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const locale = toLocale((await params).lang);
  const site = "https://serveos.tech";
  return {
    title: META[locale].title,
    description: META[locale].description,
    alternates: {
      canonical: locale === "ar" ? `${site}/` : `${site}/en`,
      languages: { ar: `${site}/`, en: `${site}/en` },
    },
  };
}

export default async function MarketingPage({ params }: { params: Promise<{ lang: string }> }) {
  const locale = toLocale((await params).lang);

  // /ar and /en are reachable on any host; only the marketing surface serves them.
  const surface = (await headers()).get("x-surface");
  if (surface !== "marketing") notFound();

  // listPlans() has no isActive predicate, so filter here rather than change a
  // shared service the admin console also calls. isActive is a text column.
  const plans = (await listPlans()).filter((p) => p.isActive === "true");

  // TradeProvider reads useSearchParams, so it sits behind a Suspense boundary.
  // This route is already dynamic (headers() above), but the boundary keeps it
  // correct if that ever changes.
  return (
    <Suspense>
      <TradeProvider locale={locale}>
        <PaperSurface>
          <Header locale={locale} />
          <main>
            <Hero />
            <TradeBand />
            <MotionReveal><Story locale={locale} /></MotionReveal>
            <MotionReveal><SurfaceTour /></MotionReveal>
            <PhotoBand />
            <MotionReveal><FeatureGrid /></MotionReveal>
            <MotionReveal><Steps /></MotionReveal>
            <DemoBand locale={locale} />
            <MotionReveal><Outcomes locale={locale} /></MotionReveal>
            <MotionReveal><Pricing plans={plans} locale={locale} /></MotionReveal>
            <MotionReveal><Faq locale={locale} /></MotionReveal>
            <PhotoBand />
            <ClosingCta locale={locale} />
          </main>
          <Footer locale={locale} />
        </PaperSurface>
      </TradeProvider>
    </Suspense>
  );
}
