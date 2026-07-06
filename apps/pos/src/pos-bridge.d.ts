export {};
declare global {
  interface Window { pos: { ping: () => string } }
}
