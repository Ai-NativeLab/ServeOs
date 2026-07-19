import { describe, it, expect } from "vitest";
import { holdTicket, listHeldTickets, discardHeldTicket } from "./held-tickets";
import { seedPosContext } from "./test-helpers";

describe("held tickets", () => {
  it("parks a ticket and lists it back", async () => {
    const { ctx } = await seedPosContext("owner");
    const { id } = await holdTicket(ctx, "Table 4", { lines: [{ productId: "p", quantity: 1 }] });
    const list = await listHeldTickets(ctx);
    expect(list.map((t) => t.id)).toContain(id);
    expect(list.find((t) => t.id === id)!.label).toBe("Table 4");
  });

  it("discards a ticket", async () => {
    const { ctx } = await seedPosContext("owner");
    const { id } = await holdTicket(ctx, "Table 9", { lines: [] });
    await discardHeldTicket(ctx, id);
    const list = await listHeldTickets(ctx);
    expect(list.map((t) => t.id)).not.toContain(id);
  });
});
