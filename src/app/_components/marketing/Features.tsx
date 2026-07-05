import { FeatureIcon, FeatureIconSprite, type FeatureIconId } from "@/components/brand/FeatureIcon";

const FEATURES: {
  id: FeatureIconId;
  title: string;
  description: string;
  tone: "coral" | "teal";
}[] = [
  {
    id: "ic-qr",
    title: "QR Menu & Ordering",
    description: "Every table gets a menu customers can browse and order from in seconds.",
    tone: "coral",
  },
  {
    id: "ic-chat",
    title: "WhatsApp Ordering",
    description: "No app required — customers order straight from a chat they already have open.",
    tone: "coral",
  },
  {
    id: "ic-table",
    title: "Table Reservations",
    description: "Take bookings without a phone tied up all service.",
    tone: "coral",
  },
  {
    id: "ic-pos",
    title: "Point of Sale",
    description: "One system for online orders and in-house sales — nothing to reconcile by hand.",
    tone: "coral",
  },
  {
    id: "ic-inventory",
    title: "Inventory Control",
    description: "Stock updates as orders come in, so you know what's running low.",
    tone: "teal",
  },
  {
    id: "ic-analytics",
    title: "Live Analytics",
    description: "See what's selling, when, and where — as it happens.",
    tone: "teal",
  },
];

export function MarketingFeatures() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-24">
      <FeatureIconSprite />

      <div className="mb-12 max-w-2xl">
        <p className="eyebrow text-primary">What you get</p>
        <h2 className="mt-2 font-display text-3xl font-bold text-ink sm:text-4xl">
          Everything your restaurant needs to take orders online.
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.id} className="rounded-xl border bg-card p-6">
            <div
              className={
                f.tone === "coral"
                  ? "mb-4 grid size-12 place-items-center rounded-lg bg-accent text-primary"
                  : "mb-4 grid size-12 place-items-center rounded-lg bg-[#DBF3F0] text-[#0FB5A6]"
              }
            >
              <FeatureIcon id={f.id} className="size-6" />
            </div>
            <h3 className="font-display text-lg font-bold text-ink">{f.title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{f.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
