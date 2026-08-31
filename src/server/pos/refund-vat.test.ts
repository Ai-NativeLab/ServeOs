/**
 * The refund-VAT allocator, tested WITHOUT a database — `refund-vat.ts` is pure
 * on purpose, so this file runs in milliseconds and can afford to hammer the
 * allocation space far harder than the integration tests in `refund.test.ts`
 * (which stay as the proof that `issueRefund` actually stores these figures).
 *
 * Two halves: direct pins on each pipeline stage, then a seeded property
 * hammer. The hammer's seed is a constant so a failure is reproducible from the
 * test name alone — never `Date.now()`.
 *
 * On timings: the 15,000 generated cases cost ~0.7s of actual computation. The
 * ~70ms each of the pinned cases also reports is the SUITE's global
 * `beforeEach` truncating the remote test database (`src/db/test-setup.ts`) —
 * nothing in this file touches it.
 */

import { describe, it, expect } from "vitest";
import { compareDecimal, sumDecimal } from "@/server/fiscal/decimal";
import { PosRefundError } from "./errors";
import {
  computeRefundVat,
  floorLineVatsAt0,
  headerlessRefundVat,
  itemisedLineVat,
  topUpToRemaining,
  type OrderItemVatBasis,
  type OrderVatBasis,
  type RefundVatInput,
  type RefundVatLine,
} from "./refund-vat";

/** Integer cents → the `money(n)` spelling, built by string surgery so the
 *  fixtures themselves never round a float. */
const money = (cents: number): string => {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

const MONEY_2DP = /^\d+\.\d{2}$/; // no leading "-": a stored VAT is never negative

const order = (vat: string, subtotal: string, serviceCharge: string | null = null): OrderVatBasis => ({
  vatAmount: vat, subtotal, serviceChargeAmount: serviceCharge,
});
const item = (id: string, quantity: number, lineTotal: string): OrderItemVatBasis => ({ id, quantity, lineTotal });
const line = (orderItemId: string, quantity: number, amount: string): RefundVatLine => ({ orderItemId, quantity, amount });

describe("itemisedLineVat — stages 1-3 (bucket → item → unit)", () => {
  it("splits the order's VAT across item lines, largest remainder deciding the odd cent", () => {
    // 100.00 + 33.33 VAT-inclusive at 14% → 16.37, and the cent lands on the
    // bigger line (remainder 10409 vs 2924).
    const o = order("16.37", "133.33");
    const items = [item("a", 1, "100.00"), item("b", 1, "33.33")];
    expect(itemisedLineVat(o, [line("a", 1, "100.00")], items, new Map())).toEqual(["12.28"]);
    expect(itemisedLineVat(o, [line("b", 1, "33.33")], items, new Map())).toEqual(["4.09"]);
  });

  it("splits a line's VAT across its own units, and skips the units earlier refunds took", () => {
    // 8.19 over two units is an ODD number of cents: 4.10 then 4.09.
    const o = order("8.19", "66.66");
    const items = [item("a", 2, "66.66")];
    expect(itemisedLineVat(o, [line("a", 1, "33.33")], items, new Map())).toEqual(["4.10"]);
    expect(itemisedLineVat(o, [line("a", 1, "33.33")], items, new Map([["a", 1]]))).toEqual(["4.09"]);
  });

  it("withholds the service charge's bucket from item lines", () => {
    // 100.00 item + 10.00 service charge, VAT-inclusive 14% → 13.51 = 12.28 + 1.23.
    const o = order("13.51", "100.00", "10.00");
    expect(itemisedLineVat(o, [line("a", 1, "100.00")], [item("a", 1, "100.00")], new Map())).toEqual(["12.28"]);
  });

  it("two lines of the SAME item inside one refund take different units, never the same twice", () => {
    const o = order("8.19", "66.66");
    const items = [item("a", 2, "66.66")];
    expect(itemisedLineVat(o, [line("a", 1, "33.33"), line("a", 1, "33.33")], items, new Map())).toEqual(["4.10", "4.09"]);
  });

  it("under-allocates rather than inventing VAT when a line claims more units than were sold", () => {
    const o = order("8.19", "66.66");
    expect(itemisedLineVat(o, [line("a", 5, "166.65")], [item("a", 2, "66.66")], new Map())).toEqual(["8.19"]);
  });

  it("a zero-VAT order allocates zeros", () => {
    expect(itemisedLineVat(order("0.00", "100.00"), [line("a", 1, "100.00")], [item("a", 1, "100.00")], new Map()))
      .toEqual(["0.00"]);
  });
});

describe("topUpToRemaining — stage 4", () => {
  it("passes the lines through untouched when there is nothing to top up to", () => {
    expect(topUpToRemaining(["12.28"], [line("a", 1, "100.00")], null)).toEqual(["12.28"]);
  });

  it("lifts the lines to the remaining VAT, spreading the residual over the money each returned", () => {
    expect(topUpToRemaining(["12.28"], [line("a", 1, "110.00")], "13.51")).toEqual(["13.51"]);
    expect(topUpToRemaining(["12.28", "4.09"], [line("a", 1, "100.00"), line("b", 1, "33.33")], "18.01"))
      .toEqual(["13.51", "4.50"]);
  });

  it("scales the lines DOWN when an earlier goodwill refund already took part of the VAT", () => {
    expect(topUpToRemaining(["24.56"], [line("a", 2, "100.00")], "12.28")).toEqual(["12.28"]);
  });

  it("falls back to quantity weights when a full refund's lines carry no amounts", () => {
    // Weighting by zero amounts would throw "cannot allocate … every weight is zero".
    expect(topUpToRemaining(["12.28"], [line("a", 1, "0.00")], "13.51")).toEqual(["13.51"]);
    expect(topUpToRemaining(["4.00", "4.00"], [line("a", 1, "0.00"), line("b", 3, "0.00")], "12.00"))
      .toEqual(["5.00", "7.00"]);
  });
});

describe("floorLineVatsAt0 — stage 5", () => {
  it("returns already-legal parts untouched", () => {
    expect(floorLineVatsAt0(["1.00", "0.00"], "1.00")).toEqual(["1.00", "0.00"]);
  });

  it("floors the negative line and re-spreads onto the line still holding VAT", () => {
    // The 190.00/10.00 order refunded with inverted 10.00/190.00 line amounts.
    expect(floorLineVatsAt0(["22.13", "-21.57"], "0.56")).toEqual(["0.56", "0.00"]);
  });

  it("re-spreads across several absorbers without pushing any of them negative", () => {
    expect(floorLineVatsAt0(["5.00", "5.00", "-4.00"], "6.00")).toEqual(["3.00", "3.00", "0.00"]);
  });

  it("floors everything only when the target is zero, and says so loudly otherwise", () => {
    expect(floorLineVatsAt0(["-1.00", "-2.00"], "0.00")).toEqual(["0.00", "0.00"]);
    expect(() => floorLineVatsAt0(["-1.00", "-2.00"], "1.00")).toThrow(/refund: cannot floor/);
  });
});

describe("headerlessRefundVat", () => {
  it("returns the whole remaining VAT when the refund clears the balance", () => {
    expect(headerlessRefundVat("14.00", "114.00", "114.00")).toBe("14.00");
    expect(headerlessRefundVat("12.28", "100.00", "100.00")).toBe("12.28");
  });

  it("scales by the share of the balance handed back, half-up at 2dp", () => {
    expect(headerlessRefundVat("14.00", "45.00", "114.00")).toBe("5.53"); // 5.5263… → 5.53, not 5.52
    expect(headerlessRefundVat("24.56", "195.44", "200.00")).toBe("24.00");
  });

  it("is zero when there is nothing left to reverse, or nothing was outstanding", () => {
    expect(headerlessRefundVat("0.00", "10.00", "100.00")).toBe("0.00");
    expect(headerlessRefundVat("14.00", "10.00", "0.00")).toBe("0.00");
  });
});

describe("computeRefundVat", () => {
  it("refuses, by name and with the remedy, a refund that would breach the order's VAT", () => {
    const err = (() => {
      try {
        computeRefundVat({
          order: order("24.56", "200.00"),
          kind: "partial",
          lines: [line("a", 2, "100.00")],
          items: [item("a", 2, "200.00")],
          alreadyReturned: new Map(),
          priorVatAmounts: ["12.28"],
          thisTotal: "100.00",
          outstanding: "100.00",
        });
        return null;
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(PosRefundError);
    expect((err as Error).message).toContain("24.56 the order charged");
    expect((err as Error).message).toContain("issue this as a full refund without item lines instead");
  });

  it("reads already-breached prior data as nothing left to reverse, and refuses it as a 400", () => {
    expect(() => computeRefundVat({
      order: order("10.00", "100.00"),
      kind: "full",
      lines: [line("a", 1, "100.00")],
      items: [item("a", 1, "100.00")],
      alreadyReturned: new Map(),
      priorVatAmounts: ["99.00"], // corrupt: already past the order's own VAT
      thisTotal: "100.00",
      outstanding: "100.00",
    })).toThrow(PosRefundError);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The hammer.
 * ────────────────────────────────────────────────────────────────────────── */

/** A tiny deterministic LCG (Numerical Recipes constants) — no dependency, and
 *  the same sequence on every machine and every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const SEED = 20260831;
const PIPELINE_CASES = 10_000;
const FLOOR_CASES = 5_000;

const pick = <T,>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const int = (rnd: () => number, maxInclusive: number): number => Math.floor(rnd() * (maxInclusive + 1));

/**
 * An ADMISSIBLE case: the order's figures are shaped the way `computeOrderTotals`
 * would leave them (VAT derived from `subtotal + serviceCharge`, never invented
 * against a zero base), while the refund itself is deliberately pathological —
 * inverted amounts, zero amounts, exhausted units, prior VAT eating the ceiling.
 */
function generateCase(rnd: () => number): RefundVatInput {
  const n = 1 + int(rnd, 7); // ≤ 8 lines
  const items = Array.from({ length: n }, (_, i) => ({
    id: `item-${String(i).padStart(2, "0")}`,
    quantity: 1 + int(rnd, 3),
    // Exact zeros, sub-cent-scale positives, ties (a repeated constant) and
    // ordinary money all in the draw.
    lineTotalCents: pick(rnd, [0, 1, 2, 3, 1_00, 33_33, 100_00, 190_00, 1_000_00]),
  }));
  const grossCents = items.reduce((s, i) => s + i.lineTotalCents, 0);
  const discountCents = rnd() < 0.3 ? int(rnd, grossCents) : 0;
  const subtotalCents = grossCents - discountCents;
  const serviceChargeCents = rnd() < 0.4 ? Math.round(subtotalCents * pick(rnd, [0.05, 0.1, 0.125])) : 0;
  const taxableCents = subtotalCents + serviceChargeCents;
  const vatCents = pick(rnd, [
    0,
    Math.round((taxableCents * 14) / 114), // VAT-inclusive
    Math.round((taxableCents * 14) / 100), // VAT-exclusive
    Math.round((taxableCents * 5) / 105),
  ]);

  const kind = rnd() < 0.5 ? "full" : "partial";
  const headerless = kind === "full" && rnd() < 0.35;
  const lineCount = headerless ? 0 : 1 + int(rnd, n - 1);
  const lines: RefundVatLine[] = Array.from({ length: lineCount }, (_, i) => {
    const target = items[(i + int(rnd, n)) % n];
    return {
      orderItemId: target.id,
      quantity: 1 + int(rnd, target.quantity - 1),
      // Amounts point wherever they like: a full refund's lines are never
      // validated against its tenders, which is what makes the floor reachable.
      amount: money(pick(rnd, [0, 1, 10_00, 190_00, target.lineTotalCents, grossCents - target.lineTotalCents])),
    };
  });

  const alreadyReturned = new Map<string, number>();
  for (const i of items) if (rnd() < 0.4) alreadyReturned.set(i.id, int(rnd, i.quantity));

  // Prior VAT: usually inside the ceiling (including "almost all of it", the
  // large-negative-residual dimension), occasionally past it (corrupt data).
  const priorTotal = rnd() < 0.12 ? vatCents + 1 + int(rnd, 500) : int(rnd, vatCents);
  const priorVatAmounts = priorTotal === 0
    ? (rnd() < 0.5 ? [] : ["0.00"])
    : [money(Math.floor(priorTotal / 2)), money(priorTotal - Math.floor(priorTotal / 2))];

  // Money actually moves: `issueRefund` rejects a non-positive payment, so a
  // zero balance or a zero refund is not an admissible shape.
  const outstandingCents = 1 + int(rnd, Math.max(taxableCents, 1));
  const thisTotalCents = rnd() < 0.5 ? outstandingCents : 1 + int(rnd, outstandingCents - 1);

  return {
    order: {
      vatAmount: money(vatCents),
      subtotal: money(subtotalCents),
      serviceChargeAmount: serviceChargeCents === 0 && rnd() < 0.5 ? null : money(serviceChargeCents),
    },
    kind,
    lines,
    items: items.map((i) => ({ id: i.id, quantity: i.quantity, lineTotal: money(i.lineTotalCents) })),
    alreadyReturned,
    priorVatAmounts,
    thisTotal: money(thisTotalCents),
    outstanding: money(outstandingCents),
  };
}

describe(`refund VAT property hammer (LCG seed ${SEED}, deterministic)`, () => {
  it(`holds every invariant over ${PIPELINE_CASES.toLocaleString()} admissible pathological cases`, () => {
    const rnd = lcg(SEED);
    const seen = { threw: 0, headerless: 0, toppedUp: 0, scaledDown: 0, zeroVat: 0, exhausted: 0 };

    for (let n = 0; n < PIPELINE_CASES; n++) {
      const input = generateCase(rnd);
      const priorVat = sumDecimal("prior", input.priorVatAmounts);
      const unreversed = compareDecimal(priorVat, input.order.vatAmount) >= 0
        ? "0.00"
        : sumDecimal("remaining", [input.order.vatAmount, `-${priorVat}`]);

      let result;
      try {
        result = computeRefundVat(input);
      } catch (e) {
        // The ONLY tolerated failure is the invariant refusal: a bare Error
        // would mean a stage could not converge or could not honour its target.
        expect(e, `case ${n}: ${JSON.stringify(input, replacer)}`).toBeInstanceOf(PosRefundError);
        seen.threw++;
        continue;
      }

      const where = `case ${n}: ${JSON.stringify(input, replacer)} → ${JSON.stringify(result)}`;

      // 1. Every stored figure is a plain, non-negative 2dp numeral.
      expect(result.headerVat, where).toMatch(MONEY_2DP);
      for (const v of result.lineVats) expect(v, where).toMatch(MONEY_2DP);

      // 2. One figure per input line, in the order they were given.
      expect(result.lineVats.length, where).toBe(input.lines.length);

      // 3. Itemised refunds reconcile to the cent — no drift, ever.
      if (input.lines.length > 0) {
        expect(sumDecimal("lines", result.lineVats), where).toBe(result.headerVat);
      } else {
        seen.headerless++;
      }

      // 4. The order's declared VAT is the ceiling for the whole order.
      expect(compareDecimal(sumDecimal("all", [priorVat, result.headerVat]), input.order.vatAmount), where)
        .toBeLessThanOrEqual(0);

      // 5. A full refund that clears the balance takes exactly what is left.
      const clears = input.kind === "full" && compareDecimal(input.thisTotal, input.outstanding) >= 0;
      if (clears) expect(result.headerVat, where).toBe(unreversed);

      // 6. Deterministic: the same sale must always hash to the same document.
      if (n % 10 === 0) expect(computeRefundVat(input), where).toEqual(result);

      if (input.lines.length > 0) {
        const raw = sumDecimal("raw", itemisedLineVat(input.order, input.lines, input.items, input.alreadyReturned));
        if (clears && compareDecimal(unreversed, raw) > 0) seen.toppedUp++;
        if (clears && compareDecimal(unreversed, raw) < 0) seen.scaledDown++;
      }
      if (compareDecimal(input.order.vatAmount, "0.00") === 0) seen.zeroVat++;
      if ([...input.alreadyReturned.entries()].some(([id, q]) => q >= (input.items.find((i) => i.id === id)?.quantity ?? 0))) {
        seen.exhausted++;
      }
    }

    // The hammer is only worth committing if it actually reaches the corners.
    expect(seen.threw).toBeGreaterThan(100);
    expect(seen.headerless).toBeGreaterThan(100);
    expect(seen.toppedUp).toBeGreaterThan(100);
    expect(seen.scaledDown).toBeGreaterThan(100);
    expect(seen.zeroVat).toBeGreaterThan(100);
    expect(seen.exhausted).toBeGreaterThan(100);
  });

  it(`floors ${FLOOR_CASES.toLocaleString()} random negative-bearing splits without drift or divergence`, () => {
    const rnd = lcg(SEED + 1);
    let withNegatives = 0;

    for (let n = 0; n < FLOOR_CASES; n++) {
      const count = 1 + int(rnd, 7);
      const cents = Array.from({ length: count }, () => pick(rnd, [-5_000, -100, -1, 0, 1, 2, 100, 5_000]));
      // The stage's contract is "Σ parts is already the target"; a target below
      // zero is the caller's bug, guarded by its own throw and pinned above.
      const total = cents.reduce((s, c) => s + c, 0);
      if (total < 0) cents[0] -= total;
      const parts = cents.map(money);
      const target = money(cents.reduce((s, c) => s + c, 0));
      if (cents.some((c) => c < 0)) withNegatives++;

      const floored = floorLineVatsAt0(parts, target);
      const where = `case ${n}: ${JSON.stringify(parts)} → ${target}`;
      for (const v of floored) expect(v, where).toMatch(MONEY_2DP);
      expect(sumDecimal("floored", floored), where).toBe(target);
      expect(floored.length, where).toBe(parts.length);
    }

    expect(withNegatives).toBeGreaterThan(1_000);
  });
});

/** Maps are invisible to `JSON.stringify`, and a failure message that hides the
 *  already-returned quantities is not reproducible. */
function replacer(_key: string, value: unknown): unknown {
  return value instanceof Map ? Object.fromEntries(value) : value;
}
