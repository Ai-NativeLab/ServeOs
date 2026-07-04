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
  const surface = (await headers()).get("x-surface");
  const isStorefront = surface === "storefront";
  return (
    <html
      lang="en"
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
