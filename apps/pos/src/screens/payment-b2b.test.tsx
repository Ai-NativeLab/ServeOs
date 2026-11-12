import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentScreen, resolveCompletionBuyer } from "./PaymentScreen";
import { EMPTY_BUYER_DRAFT, OPTIONAL_BUYER_FIELDS, REQUIRED_BUYER_FIELDS, type BuyerDraft } from "../fiscal/buyer";

/**
 * The payment screen renders to a string with `react-dom/server` — the renderer
 * has no DOM harness (see `SyncBadge.test.ts` and `Receipt.test.tsx`), so what
 * can be pinned here is the SHAPE of what a cashier is offered, not clicking
 * through it. The logic behind the section — what validates, what is built and
 * what is refused — is `../fiscal/buyer` and is unit-tested there.
 */

const render = (fiscalEnabled = true) =>
  renderToStaticMarkup(
    <PaymentScreen
      total={157.25}
      cashierName="Nadia"
      fiscalEnabled={fiscalEnabled}
      hasOpenShift
      onNeedDrawer={() => {}}
      onCancel={() => {}}
      onComplete={async () => {}}
    />,
  );

describe("the business-buyer section", () => {
  it("is COLLAPSED by default — the ordinary sale is untouched", () => {
    // Leaving it shut is a B2C sale, which is the default this screen has always
    // rung. None of the seven boxes exist in the markup until it is opened, so a
    // cashier ringing an ordinary sale is not asked anything new.
    const html = render();
    expect(html).toContain('aria-expanded="false"');
    for (const field of REQUIRED_BUYER_FIELDS) {
      expect(html, `${field.label} was rendered while collapsed`).not.toContain(`aria-label="${field.label}"`);
    }
    for (const field of OPTIONAL_BUYER_FIELDS) {
      expect(html).not.toContain(`aria-label="${field.label} (optional)"`);
    }
  });

  it("offers the section by its Arabic tax-invoice name, so a cashier can find it", () => {
    const html = render();
    expect(html).toContain("Business buyer");
    expect(html).toContain("فاتورة ضريبية");
  });

  it("still renders the ordinary tender controls beside it", () => {
    // Non-vacuity: the assertions above must be about the buyer boxes being
    // absent, not about the screen failing to render.
    const html = render();
    expect(html).toContain('aria-label="Tender amount"');
    expect(html).toContain("Complete sale");
    expect(html).toContain("157.25");
  });
});

describe("a tenant that does not file with ETA", () => {
  it("is offered NO business-buyer section at all — the payment screen is what it was before ETA", () => {
    // Non-EG, or EG with ETA activation not yet `active`: a tax invoice could
    // never be filed, so the section must not exist to be opened.
    const html = render(false);
    expect(html).not.toContain("Business buyer");
    expect(html).not.toContain("فاتورة ضريبية");
    expect(html).not.toContain("aria-expanded");
    // Non-vacuity: the screen itself still rendered.
    expect(html).toContain('aria-label="Tender amount"');
    expect(html).toContain("Complete sale");
  });
});

/**
 * The completion gate `complete()` runs, driven directly — the renderer has no
 * DOM/interaction harness, so the behaviour behind the button is pinned through
 * the pure function the button calls.
 */
describe("resolveCompletionBuyer — what the Complete button sends", () => {
  const valid: BuyerDraft = {
    ...EMPTY_BUYER_DRAFT,
    rin: "123-456-789", name: "Nile Trading Co.", governate: "Cairo",
    regionCity: "Maadi", street: "Road 9", buildingNumber: "12",
  };

  it("an OPEN, incomplete section blocks completion and names the boxes to fix", () => {
    const gate = resolveCompletionBuyer(true, { ...valid, governate: "", rin: "1234" });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.errors.governate).toBe("Required");
    expect(gate.errors.rin).toBe("Must be exactly 9 digits");
  });

  it("an OPEN, valid section passes the built buyer through", () => {
    expect(resolveCompletionBuyer(true, valid)).toEqual({
      ok: true,
      buyer: {
        rin: "123456789",
        name: "Nile Trading Co.",
        address: { country: "EG", governate: "Cairo", regionCity: "Maadi", street: "Road 9", buildingNumber: "12" },
      },
    });
  });

  it("COLLAPSING the section drops the buyer — even a fully typed one — and never validates", () => {
    expect(resolveCompletionBuyer(false, valid)).toEqual({ ok: true, buyer: undefined });
    expect(resolveCompletionBuyer(false, EMPTY_BUYER_DRAFT)).toEqual({ ok: true, buyer: undefined });
  });
});
