"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useLang } from "./LangProvider";

export function MarketingCtaBand() {
  const { t } = useLang();
  return (
    <section className="bg-primary/5 px-6 py-20 text-center">
      <h2 className="mx-auto max-w-2xl font-display text-3xl font-bold text-ink sm:text-4xl">
        {t.cta.headlineLead} <span className="text-primary">{t.cta.headlineHighlight}</span>
      </h2>
      <Button asChild size="lg" className="mt-8">
        <Link href="/register">{t.cta.getStarted}</Link>
      </Button>
    </section>
  );
}
