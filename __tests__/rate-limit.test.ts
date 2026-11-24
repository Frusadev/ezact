import { describe, expect, it } from "bun:test";
import { action, clientIp, MemoryRateLimitStore, RateLimitError, rateLimit } from "../src/index";

const req = (headers: Record<string, string>) => new Request("https://x.test", { headers });

describe("rateLimit", () => {
  it("never trusts the client-supplied first X-Forwarded-For entry", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 10.0.0.2" }))).toBe("10.0.0.2");
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(req({}))).toBeNull();
  });

  it("keeps separate counts per rateLimit() call", async () => {
    const store = new MemoryRateLimitStore();
    const make = () =>
      action({
        middleware: [rateLimit({ maxRequests: 1, store, keyGenerator: () => "same" })],
        handler: async () => "ok",
      });
    const a = make();
    const b = make();
    expect(await a()).toBe("ok");
    expect(await b()).toBe("ok");
    expect(a()).rejects.toThrow(RateLimitError);
  });

  it("sweeps expired windows and stays under its key cap", async () => {
    const store = new MemoryRateLimitStore(3);
    for (let i = 0; i < 10; i++) await store.increment(`k${i}`, 60_000);
    expect((store as unknown as { hits: Map<string, unknown> }).hits.size).toBeLessThanOrEqual(3);
  });
});
