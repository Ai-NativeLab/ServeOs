"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLang } from "./LangProvider";
import { useVertical } from "./VerticalProvider";
import { VerticalSwitcher } from "./VerticalSwitcher";
import { TicketCard } from "./TicketCard";

export function MarketingHero() {
  const { t } = useLang();
  const { v, accent, shared } = useVertical();

  return (
    <section
      id="hero"
      className="relative overflow-hidden bg-[#14120F] px-6 py-20 text-[#F7F4F1] sm:py-28"
    >
      {/* A hairline rule grid reads as counter/yard/shelf rather than as decoration, and a
          single accent wash lifts the docket off the background. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:88px_100%]" />
        {/* -end-32 (not -right-32) so the wash tracks the docket when the page flips to RTL. */}
        <div
          className="absolute -end-32 top-0 size-[46rem] rounded-full opacity-25 blur-3xl transition-colors duration-500 motion-reduce:transition-none"
          style={{ backgroundColor: accent }}
        />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(20,18,15,0.55)_0%,rgba(20,18,15,0.2)_40%,rgba(20,18,15,0.85)_100%)]" />
      </div>

      <div className="relative mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
        <div>
          <VerticalSwitcher />

          <div
            className="mt-8 inline-flex items-center gap-2 rounded-full border px-4 py-1.5 font-mono text-xs uppercase tracking-[0.14em]"
            style={{ borderColor: `${accent}4D`, backgroundColor: `${accent}14`, color: accent }}
          >
            <span className="size-1.5 rounded-full motion-safe:animate-pulse" style={{ backgroundColor: accent }} />
            {v.badge}
          </div>

          <h1 className="font-display mt-6 text-[clamp(2.25rem,5vw,4rem)] font-extrabold leading-[1.03] tracking-tight text-[#FFFDFB]">
            {v.headlineLead}{" "}
            <span className="transition-colors duration-300 motion-reduce:transition-none" style={{ color: accent }}>
              {shared.headlineHighlight}
            </span>
          </h1>

          <p className="mt-6 max-w-[52ch] text-base text-[#F7F4F1]/80 sm:text-lg">{v.subhead}</p>

          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Button
              asChild
              size="lg"
              style={{ backgroundColor: accent, color: "#14120F" }}
              className="font-semibold hover:opacity-90"
            >
              <Link href="/register">
                {t.hero.getStarted} <ArrowRight className="size-4 rtl:-scale-x-100" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-[#F7F4F1]/30 bg-transparent text-[#F7F4F1] hover:bg-white/5 hover:text-[#F7F4F1]"
            >
              <Link href="/login">{t.hero.signIn}</Link>
            </Button>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-2 text-sm text-[#F7F4F1]/60">
            <span style={{ color: accent }}>●</span>
            <span>{t.hero.trustNoLockIn}</span>
            <span aria-hidden="true">·</span>
            <span>{t.hero.trustLanguages}</span>
          </div>
        </div>

        <div className="mx-auto w-full max-w-sm lg:mx-0 lg:max-w-none">
          <TicketCard />
        </div>
      </div>
    </section>
  );
}
