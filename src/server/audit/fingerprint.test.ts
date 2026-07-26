import { describe, it, expect } from "vitest";
import { webFingerprint, emptyFingerprint } from "./fingerprint";
import { sha256Hex } from "./canonical";

describe("webFingerprint", () => {
  it("derives ip + userAgent from headers, device fields null", () => {
    const req = new Request("https://x/api/orders", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8", "user-agent": "Mozilla/5.0" },
    });
    const fp = webFingerprint(req);
    expect(fp.ip).toBe("1.2.3.4"); // first hop
    expect(fp.userAgent).toBe("Mozilla/5.0");
    expect(fp.deviceId).toBeNull();
    expect(fp.deviceTokenHash).toBeNull();
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const req = new Request("https://x/api/orders", { headers: { "x-real-ip": "9.9.9.9" } });
    expect(webFingerprint(req).ip).toBe("9.9.9.9");
  });

  it("is null ip + userAgent when no address/UA headers are present", () => {
    const fp = webFingerprint(new Request("https://x/api/orders"));
    expect(fp.ip).toBeNull();
    expect(fp.userAgent).toBeNull();
  });
});

describe("emptyFingerprint", () => {
  it("is all null", () => {
    expect(emptyFingerprint()).toEqual({
      deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null,
    });
  });
});

describe("token hashing (POS)", () => {
  it("hashes, never stores raw", () => {
    const token = "dev-secret-token";
    expect(sha256Hex(token)).not.toBe(token);
    expect(sha256Hex(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
