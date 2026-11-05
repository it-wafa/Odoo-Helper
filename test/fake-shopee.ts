/**
 * Shopee Open API tiruan untuk test: tukar code, refresh token, dan
 * get_order_detail. Tanda tangan diperiksa sungguhan dengan partner key test,
 * supaya cara Worker menandatangani ikut teruji.
 */
export type FakeOrder = { order_sn: string; create_time: number; pay_time?: number };

export class FakeShopee {
  orders = new Map<string, FakeOrder>();
  calls: { path: string; query: Record<string, string>; body?: Record<string, unknown> }[] = [];
  /** Refresh token yang masih sah; yang lama ditolak setelah dipakai. */
  validRefresh = new Set<string>();
  validAccess = new Set<string>();
  private seq = 0;

  constructor(
    private readonly partnerId: number,
    private readonly partnerKey: string,
  ) {}

  addOrder(o: FakeOrder) {
    this.orders.set(o.order_sn, o);
  }

  private async sign(base: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.partnerKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private issue(): Record<string, unknown> {
    const n = ++this.seq;
    this.validAccess.add(`access-${n}`);
    this.validRefresh.add(`refresh-${n}`);
    return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expire_in: 14400, error: "", message: "" };
  }

  async handle(url: URL, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const q = Object.fromEntries(url.searchParams);
    this.calls.push({ path: url.pathname, query: q, body });
    if (Number(q.partner_id) !== this.partnerId) return { error: "error_param", message: "partner_id" };
    const shopPart = q.access_token ? `${q.access_token}${q.shop_id}` : "";
    if (q.sign !== (await this.sign(`${this.partnerId}${url.pathname}${q.timestamp}${shopPart}`))) {
      return { error: "error_sign", message: "Wrong sign." };
    }
    switch (url.pathname) {
      case "/api/v2/auth/token/get":
        return body?.code === "good-code" ? this.issue() : { error: "error_auth", message: "invalid code" };
      case "/api/v2/auth/access_token/get": {
        const rt = String(body?.refresh_token);
        if (!this.validRefresh.delete(rt)) return { error: "error_auth", message: "Invalid refresh_token." };
        return this.issue();
      }
      case "/api/v2/order/get_order_detail": {
        if (!this.validAccess.has(q.access_token ?? "")) {
          return { error: "invalid_acceess_token", message: "Invalid access_token." };
        }
        const wantPay = (q.response_optional_fields ?? "").split(",").includes("pay_time");
        const list = (q.order_sn_list ?? "")
          .split(",")
          .map((sn) => this.orders.get(sn))
          .filter((o): o is FakeOrder => o !== undefined)
          .map((o) => (wantPay ? o : { order_sn: o.order_sn, create_time: o.create_time }));
        return { error: "", message: "", response: { order_list: list } };
      }
      default:
        return { error: "error_not_found", message: url.pathname };
    }
  }

  /** Pasang sebagai `fetch` global; panggilan ke host lain diteruskan. */
  install(host: string): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!url.href.startsWith(host)) return original(input as RequestInfo, init);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      return Response.json(await this.handle(url, body));
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }
}
