import { describe, it, expect } from "vitest";
import { buildManifest } from "./manifest";

describe("buildManifest", () => {
  it("uses the tenant's name and brand color", () => {
    const m = buildManifest({ name: "Pizza Roma", primaryColor: "#E11D48", slug: "roma" });
    expect(m.name).toBe("Pizza Roma");
    expect(m.theme_color).toBe("#E11D48");
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.icons.length).toBeGreaterThan(0);
  });
});
