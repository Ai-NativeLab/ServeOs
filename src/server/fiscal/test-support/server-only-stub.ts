/**
 * What `import "server-only"` resolves to under vitest (see vitest.config.ts).
 *
 * Next.js handles the marker at compile time — it errors when a server-only
 * module reaches a client bundle and is a no-op on the server — so the npm
 * package is not installed. Tests run in plain Node, which is "the server",
 * so the marker is exactly a no-op here.
 */
export {};
