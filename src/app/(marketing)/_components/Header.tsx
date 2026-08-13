import Link from "next/link";
import { LogoMark } from "@/components/brand/LogoMark";
import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/shared/errors";
import { CHROME } from "../_content/chrome";
import "../_motion/surface-links.css";

export function Header({ locale }: { locale: Locale }) {
  const t = CHROME[locale];
  const otherHref = locale === "ar" ? "/en" : "/";

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="#hero" className="flex items-center gap-2">
          <LogoMark className="size-7 text-primary" />
          <Wordmark className="text-lg" />
        </Link>

        <nav aria-label={t.a11y.primaryNav} className="hidden items-center gap-8 text-sm font-medium text-muted-foreground md:flex">
          <a href="#surfaces" className="mk-underline hover:text-foreground">{t.nav.platform}</a>
          <a href="#features" className="mk-underline hover:text-foreground">{t.nav.trades}</a>
          <a href="#pricing" className="mk-underline hover:text-foreground">{t.nav.pricing}</a>
          <a href="#demo" className="mk-underline hover:text-foreground">{t.nav.demo}</a>
        </nav>

        <div className="flex items-center gap-3">
          <Link href={otherHref} className="text-sm text-muted-foreground hover:text-foreground" hrefLang={locale === "ar" ? "en" : "ar"}>
            {t.otherLocale}
          </Link>
          <Link href="/login" className="hidden text-sm font-medium text-muted-foreground hover:text-foreground md:inline">
            {t.signIn}
          </Link>
          <Button asChild size="sm">
            <Link href="/register">{t.getStarted}</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
