import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentScreen } from "./PaymentScreen";
import { OPTIONAL_BUYER_FIELDS, REQUIRED_BUYER_FIELDS } from "../fiscal/buyer";

/**
 * The payment screen renders to a string with `react-dom/server` — the renderer
 * has no DOM harness (see `SyncBadge.test.ts` and `Receipt.test.tsx`), so what
 * can be pinned here is the SHAPE of what a cashier is offered, not clicking
 * through it. The logic behind the section — what validates, what is built and
 * what is refused — is `../fiscal/buyer` and is unit-tested there.
 */

const render = () =>
  renderToStaticMarkup(
    <PaymentScreen
      total={157.25}
      cashierName="Nadia"
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
