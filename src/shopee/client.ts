export class ShopeeError extends Error {
  constructor(
    message: string,
    /** Kode `error` dari Shopee, mis. `invalid_acceess_token`. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ShopeeError";
  }
}

/** Token toko di KV. Tidak pernah dipulangkan lewat endpoint. */
export type ShopToken = {
  shopId: number;
  accessToken: string;
  refreshToken: string;
  /** ms epoch; access token Shopee berlaku sekitar 4 jam. */
  expiresAt: number;
  refreshedAt: number;
};

type ClientOptions = {
  host: string;
  partnerId: number;
  partnerKey: string;
  shopId: number;
  kv: KVNamespace;
  timeoutMs?: number;
};

export type OrderDetail = { order_sn: string; create_time?: number; pay_time?: number };

/** Access token diperbarui bila sisa umurnya kurang dari ini. */
const REFRESH_MARGIN_MS = 10 * 60_000;
/** `get_order_detail` menerima paling banyak 50 pesanan per panggilan. */
export const ORDER_DETAIL_BATCH = 50;

export function tokenKey(shopId: number): string {
  return `token:${shopId}`;
}

/**
 * Klien Shopee Open API v2 untuk satu toko (App "Seller In House System").
 *
 * Setiap panggilan ditandatangani HMAC-SHA256 dengan partner key:
 * - API publik (otorisasi): partner_id + path + timestamp
 * - API toko: partner_id + path + timestamp + access_token + shop_id
 *
 * Refresh token berganti setiap kali dipakai, dan Secrets Worker tidak bisa
 * diubah dari dalam Worker, jadi token disimpan di KV.
 */
export class ShopeeClient {
  /** Jumlah panggilan HTTP; ikut batas 50 subrequest per invocation. */
  calls = 0;

  constructor(private readonly opts: ClientOptions) {}

  private async sign(base: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.opts.partnerKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async publicUrl(path: string): Promise<URL> {
    const ts = Math.floor(Date.now() / 1000);
    const url = new URL(path, this.opts.host);
    url.searchParams.set("partner_id", String(this.opts.partnerId));
    url.searchParams.set("timestamp", String(ts));
    url.searchParams.set("sign", await this.sign(`${this.opts.partnerId}${path}${ts}`));
    return url;
  }

  private async request<T>(url: URL, init: RequestInit = {}): Promise<T> {
    this.calls++;
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      headers: { "Content-Type": "application/json" },
    });
    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ShopeeError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    // Galat Shopee bisa datang dengan HTTP 200 maupun 4xx; `error` yang terisi
    // menandakan galat.
    if (body.error) {
      throw new ShopeeError(`${String(body.error)}: ${String(body.message ?? "")}`, String(body.error));
    }
    if (!res.ok) throw new ShopeeError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return body as T;
  }

  /** Tautan halaman otorisasi toko; Shopee kembali ke `redirect` membawa `code` dan `shop_id`. */
  async authLink(redirect: string): Promise<string> {
    const url = await this.publicUrl("/api/v2/shop/auth_partner");
    url.searchParams.set("redirect", redirect);
    return url.href;
  }

  /** Tukar `code` dari callback otorisasi (berlaku 10 menit) dengan token, lalu simpan. */
  async exchangeCode(code: string): Promise<ShopToken> {
    const res = await this.request<TokenResponse>(await this.publicUrl("/api/v2/auth/token/get"), {
      method: "POST",
      body: JSON.stringify({ code, shop_id: this.opts.shopId, partner_id: this.opts.partnerId }),
    });
    return this.save(res);
  }

  async loadToken(): Promise<ShopToken | null> {
    return this.opts.kv.get<ShopToken>(tokenKey(this.opts.shopId), "json");
  }

  /**
   * Access token yang masih berlaku, diperbarui bila hampir habis. `null` bila
   * toko belum diotorisasi.
   */
  async accessToken(): Promise<string | null> {
    const token = await this.loadToken();
    if (!token) return null;
    if (token.expiresAt - Date.now() > REFRESH_MARGIN_MS) return token.accessToken;
    // Bila refresh gagal, token lama dibiarkan di KV supaya putaran berikutnya
    // bisa mencoba lagi; galatnya dilaporkan pemanggil.
    const res = await this.request<TokenResponse>(await this.publicUrl("/api/v2/auth/access_token/get"), {
      method: "POST",
      body: JSON.stringify({
        refresh_token: token.refreshToken,
        shop_id: this.opts.shopId,
        partner_id: this.opts.partnerId,
      }),
    });
    return (await this.save(res)).accessToken;
  }

  /** Paksa refresh pada putaran berikutnya, mis. setelah access token ditolak. */
  async expireToken(): Promise<void> {
    const token = await this.loadToken();
    if (token) await this.opts.kv.put(tokenKey(this.opts.shopId), JSON.stringify({ ...token, expiresAt: 0 }));
  }

  private async save(res: TokenResponse): Promise<ShopToken> {
    const now = Date.now();
    const token: ShopToken = {
      shopId: this.opts.shopId,
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      expiresAt: now + res.expire_in * 1000,
      refreshedAt: now,
    };
    await this.opts.kv.put(tokenKey(this.opts.shopId), JSON.stringify(token));
    return token;
  }

  /** Detail pesanan beserta `pay_time` (detik epoch); paling banyak 50 nomor pesanan. */
  async orderDetails(accessToken: string, orderSns: string[]): Promise<OrderDetail[]> {
    if (orderSns.length === 0) return [];
    const path = "/api/v2/order/get_order_detail";
    const ts = Math.floor(Date.now() / 1000);
    const url = new URL(path, this.opts.host);
    const sign = await this.sign(`${this.opts.partnerId}${path}${ts}${accessToken}${this.opts.shopId}`);
    url.search = new URLSearchParams({
      partner_id: String(this.opts.partnerId),
      timestamp: String(ts),
      access_token: accessToken,
      shop_id: String(this.opts.shopId),
      sign,
      order_sn_list: orderSns.join(","),
      response_optional_fields: "pay_time",
    }).toString();
    const res = await this.request<{ response?: { order_list?: OrderDetail[] } }>(url);
    return res.response?.order_list ?? [];
  }
}

type TokenResponse = { access_token: string; refresh_token: string; expire_in: number };
