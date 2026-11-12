import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Underscore-prefixed parameters are intentional (forward-dep seam stubs).
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // apps/pos is an Electron + Vite app, not Next: there is no next/link router
  // or next/image optimizer to reach for, so the Next-specific rules only ever
  // produce false positives there. The React and TypeScript rules still apply.
  {
    files: ["apps/pos/**"],
    rules: {
      "@next/next/no-img-element": "off",
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Exported design-tool bundles (Claude Design hand-off), not app source.
    "Serve OS Brand Identity Concepts/**",
    "apps/pos/build/**",
    "apps/pos/dist/**",
    "apps/pos/out/**",
  ]),
]);

export default eslintConfig;
