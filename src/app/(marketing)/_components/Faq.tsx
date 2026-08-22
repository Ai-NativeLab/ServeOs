import type { FaqContent } from "../_content/faq";

/**
 * Takes its content as a prop rather than reading FAQ[locale] itself, so the
 * home page's general FAQ and the pricing page's plan FAQ are the same
 * component. The alternative — a second, near-identical component — is how two
 * FAQ styles drift apart.
 */
export function Faq({ content, id = "faq" }: { content: FaqContent; id?: string }) {
  return (
    <section id={id} className="mx-auto max-w-3xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        {content.eyebrow}
      </p>
      <h2 className="mt-4 text-3xl font-bold leading-tight tracking-[-0.03em]">{content.heading}</h2>

      <dl className="mt-10 divide-y divide-border/60">
        {content.items.map((item) => (
          <div key={item.q} className="py-5">
            <dt className="text-base font-bold tracking-[-0.01em]">{item.q}</dt>
            <dd className="mt-2 text-sm leading-7 text-muted-foreground">{item.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
