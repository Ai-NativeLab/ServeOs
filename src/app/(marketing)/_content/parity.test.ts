import { describe, it, expect } from "vitest";
import { keyPaths } from "./types";
import { CHROME } from "./chrome";
import { STORY } from "./story";
import { SURFACES } from "./surfaces";
import { DEMO } from "./demo";
import { FAQ } from "./faq";

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

describe("content parity between Arabic and English", () => {
  const modules = { CHROME, STORY, SURFACES, DEMO, FAQ };

  for (const [name, mod] of Object.entries(modules)) {
    it(`${name} has identical key paths in both languages`, () => {
      expect(keyPaths(mod.ar)).toEqual(keyPaths(mod.en));
    });

    it(`${name} has no empty strings`, () => {
      const empties: string[] = [];
      const walk = (v: unknown, path: string) => {
        if (typeof v === "string" && v.trim() === "") empties.push(path);
        else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
        else if (v && typeof v === "object")
          Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`));
      };
      walk(mod, name);
      expect(empties).toEqual([]);
    });
  }
});
