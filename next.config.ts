import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Wildcard covers every tenant subdomain under serveos.localhost (roma,
  // nobio, and any future vertical showcase tenant) instead of allowlisting
  // them one at a time — a hardcoded single entry here silently broke all
  // client-side interactivity (hydration/RSC requests get dev-blocked) for
  // any tenant not named "roma", which is what masked the shop template
  // having never been exercised in a real browser (Task 16).
  allowedDevOrigins: ["*.serveos.localhost"],
  // This repo is an npm workspace (apps/*). Pin the Turbopack root to the
  // project dir so it doesn't infer a wrong root from stray parent lockfiles.
  turbopack: { root: __dirname },
};

export default nextConfig;
