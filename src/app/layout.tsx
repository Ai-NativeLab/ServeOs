import type { Metadata } from "next";
import { headers } from "next/headers";
import { ServiceWorkerRegister } from "./sw-register";
import { bricolage, spaceGrotesk, jetbrainsMono, plexArabic } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "ServeOS",
  description: "Restaurant ordering, reservations, and WhatsApp commerce.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const surface = h.get("x-surface");
  const isStorefront = surface === "storefront";
  // Marketing is Arabic-first and the proxy declares the locale, so the correct
  // dir/lang ship in the first byte — no client-side flip, no layout reflow.
  // Every other surface is unchanged: no x-locale, so en/ltr as before.
  const locale = h.get("x-locale") === "ar" ? "ar" : "en";
  return (
    <html
      lang={locale}
      dir={locale === "ar" ? "rtl" : "ltr"}
      className={`${bricolage.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} ${plexArabic.variable}`}
    >
      <head>{isStorefront && <link rel="manifest" href="/manifest.webmanifest" />}</head>
      <body>
        {isStorefront && <ServiceWorkerRegister />}
        {children}
      </body>
    </html>
  );
}
