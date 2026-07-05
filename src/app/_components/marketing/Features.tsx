"use client";
import { FeatureIcon, FeatureIconSprite, type FeatureIconId } from "@/components/brand/FeatureIcon";
import { useLang } from "./LangProvider";

const FEATURES: { id: FeatureIconId; tone: "coral" | "teal" }[] = [
  { id: "ic-qr", tone: "coral" },
  { id: "ic-chat", tone: "coral" },
  { id: "ic-table", tone: "coral" },
  { id: "ic-pos", tone: "coral" },
  { id: "ic-inventory", tone: "teal" },
  { id: "ic-analytics", tone: "teal" },
];

export function MarketingFeatures() {
  const { t } = useLang();
  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-24">
      <FeatureIconSprite />

      <div className="mb-12 max-w-2xl">
        <p className="eyebrow text-primary">{t.features.eyebrow}</p>
        <h2 className="mt-2 font-display text-3xl font-bold text-ink sm:text-4xl">
          {t.features.heading}
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => {
          const copy = t.features.items[f.id];
          return (
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
              <h3 className="font-display text-lg font-bold text-ink">{copy.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{copy.description}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
