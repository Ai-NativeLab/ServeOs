import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEMO_IMAGES, imagesFor, photoId } from "./images";
import { VERTICAL_IDS } from "@/server/verticals";

const SEED = readFileSync(path.join(process.cwd(), "scripts/seed-demo-tenants.ts"), "utf8");

describe("DEMO_IMAGES", () => {
  it("covers every registered trade", () => {
    for (const trade of VERTICAL_IDS) {
      expect(Object.keys(DEMO_IMAGES[trade]).length).toBeGreaterThan(0);
    }
  });

  it("builds real Unsplash urls", () => {
    for (const trade of VERTICAL_IDS) {
      for (const url of imagesFor(trade)) {
        expect(url).toMatch(/^https:\/\/images\.unsplash\.com\/photo-/);
        expect(photoId(url)).toBeTruthy();
      }
    }
  });

  // THE RULE: food stays in restaurants, medicines in pharmacies, boards in
  // the timber yard. A grocery's logo was once Roma's "Starters" plate.
  it("never lets two trades share a photo", () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];

    for (const trade of VERTICAL_IDS) {
      for (const url of imagesFor(trade)) {
        const id = photoId(url)!;
        const existing = owner.get(id);
        if (existing && existing !== trade) {
          clashes.push(`${id} is used by both ${existing} and ${trade}`);
        }
        owner.set(id, trade);
      }
    }

    expect(clashes).toEqual([]);
  });

  it("gives every photo a name, so nobody has to guess what an id shows", () => {
    for (const trade of VERTICAL_IDS) {
      for (const key of Object.keys(DEMO_IMAGES[trade])) {
        expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});

describe("the demo seed's photography", () => {
  // Anonymous ids are how the wrong picture reaches the wrong shop: an inline
  // IMG("1584949...") carries no clue that it is a photo of a computer screen,
  // which is how it ended up on retail's entire Snacks aisle.
  it("contains no bare IMG(...) call — every photo comes from DEMO_IMAGES", () => {
    const bare = SEED.match(/\bIMG\("[^"]+"\)/g) ?? [];
    expect(bare).toEqual([]);
  });

  it("only references image names belonging to the trade being seeded", () => {
    const allNames = new Map<string, string>();
    for (const trade of VERTICAL_IDS) {
      for (const key of Object.keys(DEMO_IMAGES[trade])) allNames.set(key, trade);
    }

    const violations: string[] = [];
    for (const trade of VERTICAL_IDS) {
      // Each tenant config is a top-level `const NAME: TenantSeedConfig = {…};`
      const block = SEED.match(
        new RegExp(`const ${trade.toUpperCase()}: TenantSeedConfig = \\{([\\s\\S]*?)\\n\\};`),
      )?.[1];
      expect(block, `could not find the ${trade} config block`).toBeTruthy();

      for (const token of new Set(block!.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [])) {
        const ownedBy = allNames.get(token);
        if (ownedBy && ownedBy !== trade) {
          violations.push(`${trade} uses ${token}, which belongs to ${ownedBy}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
