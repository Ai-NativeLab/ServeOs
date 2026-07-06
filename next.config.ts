import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["roma.serveos.localhost"],
  // This repo is an npm workspace (apps/*). Pin the Turbopack root to the
  // project dir so it doesn't infer a wrong root from stray parent lockfiles.
  turbopack: { root: __dirname },
};

export default nextConfig;
