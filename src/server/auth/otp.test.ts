import { describe, it, expect } from "vitest";
import { NoopOtpProvider } from "./otp";

describe("NoopOtpProvider", () => {
  it("records the code it 'sent' so tests/dev can read it", async () => {
    const p = new NoopOtpProvider();
    await p.send("+201000000000", "123456");
    expect(p.lastSent).toEqual({ to: "+201000000000", code: "123456" });
  });
});
