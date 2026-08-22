import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { listPlans } from "@/server/subscription";
import type { Locale } from "@/shared/errors";
import { ClosingCta } from "../_components/ClosingCta";
import { DemoBand } from "../_components/DemoBand";
import { Faq } from "../_components/Faq";
import { FAQ } from "../_content/faq";
import { FeatureGrid } from "../_components/FeatureGrid";
import { Footer } from "../_components/Footer";
import { Header } from "../_components/Header";
import { Hero } from "../_components/Hero";
import { Cursor } from "../_motion/Cursor";
import { Reveal } from "../_motion/Reveal";
import { ScrollProvider } from "../_motion/ScrollProvider";
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

export default async function MarketingPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const locale = toLocale((await params).lang);

  // /ar and /en are reachable on any host; only the marketing surface serves them.
  const surface = (await headers()).get("x-surface");
  if (surface !== "marketing") notFound();

  // listPlans() has no isActive predicate, so filter here rather than change a
  // shared service the admin console also calls. isActive is a text column.
  const plans = (await listPlans()).filter((p) => p.isActive === "true");

  // TradeProvider reads useSearchParams, which normally wants a Suspense
  // boundary above it — but this route is unconditionally dynamic (headers()
  // above forces that), so Next never needs to defer it, and a boundary here
  // earns nothing. It used to wrap the whole tree in one anyway, and React's
  // streaming SSR ships a Suspense boundary's content hidden
  // (`style="display:none"`) behind a same-document reveal <script> — so with
  // JavaScript off, the entire page, Hero included, never became visible.
  // Above-the-fold content must not need JavaScript to become visible, so
  // nothing here may sit inside a Suspense boundary that isn't earning its keep.
  return (
    <ScrollProvider>
      <TradeProvider locale={locale}>
        <PaperSurface>
        <Cursor />
        <Header locale={locale} />
        <main>
          <Hero />
          <TradeBand />
          {/* Each section arrives differently, so the page reads as a sequence
              rather than the same 12px rise eight times. Hero and TradeBand are
              deliberately unwrapped — above-the-fold content must not need
              JavaScript to become visible. */}
          <Reveal kind="blur"><Story locale={locale} /></Reveal>
          <SurfaceTour />
          <Reveal kind="wipe"><PhotoBand /></Reveal>
          <Reveal kind="stagger"><FeatureGrid /></Reveal>
          <Reveal kind="slide"><Steps /></Reveal>
          <Reveal kind="wipe"><DemoBand locale={locale} /></Reveal>
          <Reveal kind="stagger"><Outcomes locale={locale} /></Reveal>
          <Reveal kind="scale"><Pricing plans={plans} locale={locale} /></Reveal>
          <Reveal kind="stagger"><Faq content={FAQ[locale]} /></Reveal>
          <Reveal kind="wipe"><PhotoBand /></Reveal>
          <Reveal kind="blur"><ClosingCta locale={locale} /></Reveal>
        </main>
          <Footer locale={locale} />
        </PaperSurface>
      </TradeProvider>
    </ScrollProvider>
  );
}
