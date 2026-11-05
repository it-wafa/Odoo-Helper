import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("/health", () => {
  it("menampilkan versi rilis, atau dev untuk deploy manual", async () => {
    const res = await SELF.fetch("https://worker.test/health");
    const body = (await res.json()) as { version: string; write_enabled: boolean };
    expect(res.status).toBe(200);
    expect(body.version).toBe("dev");
    expect(body.write_enabled).toBe(true);
  });
});
