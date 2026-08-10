import { describe, it, expect } from "vitest";
import { keyPaths } from "./types";

describe("keyPaths", () => {
  it("lists nested object paths", () => {
    expect(keyPaths({ a: 1, b: { c: 2 } })).toEqual(["a", "b.c"]);
  });

  it("ignores array length, which may legitimately differ between languages", () => {
    expect(keyPaths({ items: [{ x: 1 }, { x: 2 }] })).toEqual(["items[].x"]);
  });

  it("descends into the first element so item shape is compared", () => {
    expect(keyPaths({ items: [{ x: 1, y: 2 }] })).toEqual(["items[].x", "items[].y"]);
  });

  it("reports an empty array as a bare path rather than throwing", () => {
    expect(keyPaths({ items: [] })).toEqual(["items[]"]);
  });

  it("catches a field present in one language only", () => {
    const ar = { items: [{ q: "س", a: "ج" }] };
    const en = { items: [{ q: "q" }] };
    expect(keyPaths(ar)).not.toEqual(keyPaths(en));
  });
});
