import Link from "next/link";
import { LogoMark } from "@/components/brand/LogoMark";
import { Wordmark } from "@/components/brand/Wordmark";
import type { Locale } from "@/shared/errors";
import { CHROME } from "../_content/chrome";

export function Footer({ locale }: { locale: Locale }) {
  const t = CHROME[locale];
  const otherHref = locale === "ar" ? "/en" : "/";

  return (
    <footer className="border-t border-border/60 bg-card/40">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-1">
            <div className="flex items-center gap-2">
              <LogoMark className="size-6 text-primary" />
              <Wordmark className="text-base" />
            </div>
          </div>

          {t.footer.columns.map((col) => (
            <nav key={col.heading} aria-label={col.heading}>
              <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{col.heading}</h3>
              <ul className="mt-4 space-y-2.5 text-sm">
                {col.links.map((l) => (
                  <li key={`${col.heading}-${l.label}`}>
                    <Link href={l.href} className="text-foreground/80 hover:text-foreground">{l.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <ul className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border/60 pt-6 text-xs text-muted-foreground">
          {t.footer.trust.map((item) => <li key={item}>{item}</li>)}
        </ul>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{t.footer.copyright}</span>
          <Link href={otherHref} className="hover:text-foreground" hrefLang={locale === "ar" ? "en" : "ar"}>
            {t.otherLocale}
          </Link>
        </div>
      </div>
    </footer>
  );
}
