"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/brand/LogoMark";
import { useLang } from "./LangProvider";

export function MarketingHero() {
  const { t } = useLang();
  return (
    <section
      id="hero"
      className="relative overflow-hidden bg-[#17100B] px-6 py-28 text-[#FBF1EC] sm:py-36"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-56 size-[75rem] rounded-full bg-[radial-gradient(circle_at_center,#FF5E34_0%,rgba(240,82,43,0.55)_34%,rgba(240,82,43,0)_66%)] motion-safe:animate-[drift1_22s_ease-in-out_infinite]" />
        <div className="absolute -bottom-64 -right-36 size-[72rem] rounded-full bg-[radial-gradient(circle_at_center,#F0522B_0%,rgba(210,63,28,0.5)_36%,rgba(210,63,28,0)_68%)] motion-safe:animate-[drift2_26s_ease-in-out_infinite]" />
        <div className="absolute right-[6%] top-[44%] size-[40rem] rounded-full bg-[radial-gradient(circle_at_center,rgba(45,212,196,0.5)_0%,rgba(15,181,166,0)_62%)] motion-safe:animate-[drift3_20s_ease-in-out_infinite]" />
        <div className="absolute -bottom-32 left-[8%] h-[32rem] w-[47rem] rounded-full bg-[radial-gradient(circle_at_center,rgba(216,204,190,0.28)_0%,rgba(216,204,190,0)_60%)]" />

        <svg viewBox="0 0 1920 1080" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <g fill="none" stroke="#2DD4C4" strokeWidth={2} strokeLinecap="round" opacity={0.55}>
            <path d="M-40 210 C 320 120, 520 300, 860 220" strokeDasharray="7 16" className="motion-safe:animate-[dash_9s_linear_infinite]" />
            <path d="M1960 320 C 1600 250, 1420 430, 1120 330" strokeDasharray="6 18" className="motion-safe:animate-[dash_11s_linear_infinite]" />
            <path d="M1960 780 C 1560 700, 1440 900, 1080 820" strokeDasharray="7 16" className="motion-safe:animate-[dash_10s_linear_infinite]" />
            <path d="M-40 900 C 280 820, 500 980, 820 900" strokeDasharray="6 18" className="motion-safe:animate-[dash_13s_linear_infinite]" />
          </g>
          <g fill="#5EEBDD">
            <circle cx={860} cy={220} r={5} className="motion-safe:animate-[pulse-node_3.2s_ease-in-out_infinite]" />
            <circle cx={1120} cy={330} r={5} className="motion-safe:animate-[pulse-node_3.8s_ease-in-out_infinite_0.6s]" />
            <circle cx={1080} cy={820} r={5} className="motion-safe:animate-[pulse-node_3.4s_ease-in-out_infinite_1.1s]" />
            <circle cx={820} cy={900} r={5} className="motion-safe:animate-[pulse-node_4s_ease-in-out_infinite_0.3s]" />
          </g>
        </svg>

        <LogoMark className="absolute right-[8%] top-24 hidden size-40 text-[#FFB496]/15 lg:block motion-safe:animate-[floaty_9s_ease-in-out_infinite]" />
        <LogoMark className="absolute bottom-24 left-[7%] hidden size-32 text-[#5EEBDD]/15 lg:block motion-safe:animate-[floaty_11s_ease-in-out_infinite_1.2s]" />

        <div className="absolute inset-0 bg-[radial-gradient(ellipse_46%_54%_at_42%_52%,rgba(20,13,9,0.72)_0%,rgba(20,13,9,0.35)_45%,rgba(20,13,9,0)_78%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(20,13,9,0.4)_0%,rgba(20,13,9,0)_18%,rgba(20,13,9,0)_82%,rgba(20,13,9,0.35)_100%)]" />
      </div>

      <div className="relative mx-auto max-w-3xl">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#2DD4C4]/30 bg-[#2DD4C4]/10 px-4 py-1.5 font-mono text-xs uppercase tracking-[0.14em] text-[#5EEBDD]">
          <span className="size-1.5 rounded-full bg-[#5EEBDD] motion-safe:animate-pulse" />
          {t.hero.badge}
        </div>

        <h1 className="font-display text-[clamp(2.5rem,6vw,6rem)] font-extrabold leading-[0.98] tracking-tight text-[#FFF8F4]">
          {t.hero.headlineLead} <span className="text-[#FF7A54]">{t.hero.headlineHighlight}</span>
        </h1>

        <p className="mt-6 max-w-[46ch] text-lg text-[#FBF1EC]/90 sm:text-2xl">
          {t.hero.subhead}
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Button asChild size="lg" className="shadow-[0_20px_44px_-18px_rgba(240,82,43,0.9)]">
            <Link href="/register">
              {t.hero.getStarted} <ArrowRight className="size-4 rtl:-scale-x-100" />
            </Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="outline"
            className="border-[#FBF1EC]/35 bg-transparent text-[#FBF1EC] hover:bg-white/5 hover:text-[#FBF1EC]"
          >
            <Link href="/login">{t.hero.signIn}</Link>
          </Button>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-2 text-sm text-[#FBF1EC]/70">
          <span className="text-[#5EEBDD]">●</span>
          <span>{t.hero.trustNoLockIn}</span>
          <span aria-hidden="true">·</span>
          <span>{t.hero.trustLanguages}</span>
        </div>
      </div>
    </section>
  );
}
