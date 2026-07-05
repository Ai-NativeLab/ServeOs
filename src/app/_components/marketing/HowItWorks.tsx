const STEPS = [
  {
    n: "01",
    title: "Build your menu",
    description: "Categories, products, photos — in English and Arabic.",
  },
  {
    n: "02",
    title: "Customers order",
    description: "QR at the table, WhatsApp, or your ordering link.",
  },
  {
    n: "03",
    title: "It all lands in your dashboard",
    description: "Orders, POS, and stock update together.",
  },
];

export function MarketingHowItWorks() {
  return (
    <section id="how-it-works" className="border-t bg-secondary/40 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow text-primary">How it works</p>
        <h2 className="mt-2 font-display text-3xl font-bold text-ink sm:text-4xl">
          Live in three steps.
        </h2>

        <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n}>
              <div className="font-mono text-sm font-medium text-primary">{s.n}</div>
              <h3 className="mt-2 font-display text-lg font-bold text-ink">{s.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{s.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
