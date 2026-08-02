import { describe, it, expect } from "vitest";
import { renderRows, truncateTitle } from "./render";

describe("renderRows", () => {
  it("pages at 9 rows so a 10th slot remains for 'next'", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: `i${i}`, name: `Item ${i}` }));
    const page0 = renderRows(items, 0, "pick", 1);
    expect(page0.rows).toHaveLength(9);
    expect(page0.hasMore).toBe(true);

    const page2 = renderRows(items, 2, "pick", 1);
    expect(page2.rows).toHaveLength(7); // 25 - 18
    expect(page2.hasMore).toBe(false);
  });

  it("embeds the state version in every row id", () => {
    const { rows } = renderRows([{ id: "x", name: "X" }], 0, "pick", 4);
    expect(rows[0].id).toBe("pick:4:x");
  });
});

describe("truncateTitle", () => {
  it("caps at Meta's 24-character row-title limit", () => {
    expect(truncateTitle("Panadol Extra 500mg 24 Tablets")).toHaveLength(24);
  });

  it("leaves a short title untouched", () => {
    expect(truncateTitle("Margherita")).toBe("Margherita");
  });
});
