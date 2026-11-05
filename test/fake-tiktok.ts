/**
 * TikTok Shop Open API tiruan untuk test: `GET /order/202309/orders`.
 * Tanda tangan dan header access token diperiksa sungguhan dengan App secret
 * test, supaya cara Worker menandatangani ikut teruji.
 */
export type FakeTikTokOrder = { id: string; status: string; create_time: number; paid_time?: number; is_cod?: boolean };

export class FakeTikTok {
  orders = new Map<string, FakeTikTokOrder>();
  calls: { path: string; query: Record<string, string>; token: string | null }[] = [];
  /** Isi untuk meniru galat TikTok, mis. access token kedaluwarsa. */
  failWith: { code: number; message: string } | null = null;

  constructor(
    private readonly appKey: string,
    private readonly appSecret: string,
    private readonly accessToken: string,
    private readonly cipher: string,
  ) {}

  addOrder(o: FakeTikTokOrder) {
    this.orders.set(o.id, o);
  }

  private async sign(base: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.appSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(this.appSecret + base + this.appSecret));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async handle(url: URL, token: string | null): Promise<Record<string, unknown>> {
    const q = Object.fromEntries(url.searchParams);
    this.calls.push({ path: url.pathname, query: q, token });
    if (q.app_key !== this.appKey) return { code: 106001, message: "invalid app_key" };
    const { sign, access_token: _ignored, ...rest } = q;
    const base = url.pathname + Object.keys(rest).sort().map((k) => k + rest[k]).join("");
    if (sign !== (await this.sign(base))) return { code: 106001, message: "Invalid credentials" };
    if (token !== this.accessToken) return { code: 105002, message: "Expired credentials" };
    if (q.shop_cipher !== this.cipher) return { code: 106011, message: "shop_cipher" };
    if (this.failWith) return this.failWith;
    if (url.pathname !== "/order/202309/orders") return { code: 404, message: url.pathname };
    const ids = (q.ids ?? "").split(",");
    if (ids.length > 50) return { code: 36009004, message: "too many ids" };
    return { code: 0, message: "Success", data: { orders: ids.map((id) => this.orders.get(id)).filter(Boolean) } };
  }

  /** Pasang sebagai `fetch` global; panggilan ke host lain diteruskan. */
  install(host: string): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!url.href.startsWith(host)) return original(input as RequestInfo, init);
      const token = new Headers(init?.headers).get("x-tts-access-token");
      return Response.json(await this.handle(url, token));
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }
}
