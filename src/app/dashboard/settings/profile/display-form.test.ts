import { describe, it, expect } from "vitest";
import { parseCatalogDisplayFormData } from "./display-form";

describe("parseCatalogDisplayFormData", () => {
  it("parses valid sections display mode", () => {
    const fd = new FormData();
    fd.set("catalogDisplayMode", "sections");
    fd.set("itemsPerPage", "12");

    const result = parseCatalogDisplayFormData(fd);
    expect(result.catalogDisplayMode).toBe("sections");
    expect(result.itemsPerPage).toBe(12);
  });

  it("parses valid category_grid display mode", () => {
    const fd = new FormData();
    fd.set("catalogDisplayMode", "category_grid");

    const result = parseCatalogDisplayFormData(fd);
    expect(result.catalogDisplayMode).toBe("category_grid");
    expect(result.itemsPerPage).toBe(12);
  });

  it("parses valid paginated display mode with custom itemsPerPage", () => {
    const fd = new FormData();
    fd.set("catalogDisplayMode", "paginated");
    fd.set("itemsPerPage", "24");

    const result = parseCatalogDisplayFormData(fd);
    expect(result.catalogDisplayMode).toBe("paginated");
    expect(result.itemsPerPage).toBe(24);
  });

  it("defaults invalid display mode to sections", () => {
    const fd = new FormData();
    fd.set("catalogDisplayMode", "invalid_mode");

    const result = parseCatalogDisplayFormData(fd);
    expect(result.catalogDisplayMode).toBe("sections");
  });

  it("defaults invalid itemsPerPage to 12", () => {
    const fd = new FormData();
    fd.set("catalogDisplayMode", "paginated");
    fd.set("itemsPerPage", "-5");

    const result = parseCatalogDisplayFormData(fd);
    expect(result.catalogDisplayMode).toBe("paginated");
    expect(result.itemsPerPage).toBe(12);
  });
});
