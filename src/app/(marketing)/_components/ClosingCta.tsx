import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/shared/errors";
import { CHROME } from "../_content/chrome";

const COPY = {
  ar: { heading: "ابدأ النهارده. الباقة المجانية من غير بطاقة.", sub: "دقيقة واحدة، وأول طلب يقدر يوصلك." },
  en: { heading: "Start today. The free plan needs no card.", sub: "One minute, and your first order can arrive." },
} as const;

export function ClosingCta({ locale }: { locale: Locale }) {
  const t = COPY[locale];

  return (
    <section className="mx-auto max-w-6xl px-6 py-24 text-center">
      <h2 className="mx-auto max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>
      <p className="mt-4 text-sm text-muted-foreground">{t.sub}</p>
      <div className="mt-8">
        <Button asChild size="lg"><Link href="/register">{CHROME[locale].getStarted}</Link></Button>
      </div>
    </section>
  );
}
