/**
 * The single "is this a dev run?" signal, shared by the window loader in
 * main.ts (which renderer to show) and the base-URL resolver in pos-main.ts
 * (which backend to call). Both must key off the same predicate: if they
 * disagree, a production-looking renderer can end up talking to a dev
 * backend, or vice versa.
 *
 * vite-plugin-electron sets VITE_DEV_SERVER_URL in the environment of the
 * Electron process it spawns, so the variable is present from the first
 * module evaluation of a `npm run dev` session and absent everywhere else.
 * That makes an unpackaged run of the build output (`electron .` over
 * dist-electron) deliberately NOT dev: it loads the built renderer and
 * talks to the production backend, exactly like a packaged build — so a
 * till paired from source keeps its pairing across launches.
 */
export function devServerUrl(): string | undefined {
  return process.env.VITE_DEV_SERVER_URL || undefined;
}
