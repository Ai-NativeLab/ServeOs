import { describe, it, expect } from "vitest";
import { keyPaths } from "./types";
import { CHROME } from "./chrome";
import { STORY } from "./story";
import { SURFACES } from "./surfaces";
import { DEMO } from "./demo";
import { FAQ } from "./faq";
import { OUTCOMES } from "./outcomes";
import { TRADE_CONTENT } from "./trades";
import { VERTICAL_IDS } from "@/server/verticals";

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
  const modules = { CHROME, STORY, SURFACES, DEMO, FAQ, OUTCOMES };

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

describe("trade content", () => {
  it("covers every registered trade", () => {
    expect(Object.keys(TRADE_CONTENT).sort()).toEqual([...VERTICAL_IDS].sort());
  });

  for (const id of VERTICAL_IDS) {
    it(`${id} has identical key paths in both languages`, () => {
      expect(keyPaths(TRADE_CONTENT[id].ar)).toEqual(keyPaths(TRADE_CONTENT[id].en));
    });

    it(`${id} offers exactly six features and three steps in both languages`, () => {
      for (const locale of ["ar", "en"] as const) {
        expect(TRADE_CONTENT[id][locale].features).toHaveLength(6);
        expect(TRADE_CONTENT[id][locale].steps).toHaveLength(3);
      }
    });
  }
});

describe("outcomes", () => {
  it("ships three scenarios in both languages", () => {
    for (const locale of ["ar", "en"] as const) {
      expect(OUTCOMES[locale].items).toHaveLength(3);
    }
  });

  it("attributes nothing to a named person until a real quote exists", () => {
    for (const locale of ["ar", "en"] as const) {
      for (const item of OUTCOMES[locale].items) {
        expect(item.attribution).toBeUndefined();
      }
    }
  });
});
