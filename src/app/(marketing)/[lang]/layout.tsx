import { HtmlLocale } from "./HtmlLocale";

/**
 * `/` is rewritten to `/ar` and `/en` passes through (see marketing-locale.ts),
 * so this segment's param is the authoritative locale for the marketing surface.
 */
export default async function MarketingLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  return (
    <>
      <HtmlLocale locale={lang === "ar" ? "ar" : "en"} />
      {children}
    </>
  );
}
