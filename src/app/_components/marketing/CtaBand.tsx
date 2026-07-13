"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useLang } from "./LangProvider";
import { useVertical } from "./VerticalProvider";

export function MarketingCtaBand() {
  const { t } = useLang();
  const { v, accent, shared } = useVertical();

  return (
    <section className="px-6 py-20 text-center" style={{ backgroundColor: `${accent}0D` }}>
      <h2 className="font-display mx-auto max-w-2xl text-3xl font-bold text-ink sm:text-4xl">
        {v.headlineLead} <span style={{ color: accent }}>{shared.headlineHighlight}</span>
      </h2>
      <Button
        asChild
        size="lg"
        className="mt-8 font-semibold hover:opacity-90"
        style={{ backgroundColor: accent, color: "#14120F" }}
      >
        <Link href="/register">{t.cta.getStarted}</Link>
      </Button>
    </section>
  );
}
