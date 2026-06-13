// Minimal install/activate SW so the storefront is installable as a PWA.
// Full offline caching lands in the Ordering sub-project.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Pass-through for now; no caching yet.
});
