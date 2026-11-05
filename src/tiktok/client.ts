export class TikTokError extends Error {
  constructor(
    message: string,
    /** `code` dari TikTok Shop; 0 = sukses. */
    readonly code?: number,
  ) {
    super(message);
    this.name = "TikTokError";
  }
}

/**
 * Kredensial toko yang disimpan konektor TikTok Odoo (`tiktok.shop`). Odoo
 * yang memperbarui access token; Worker hanya memakainya, tidak pernah
 * me-refresh, supaya token milik konektor tidak berganti di luar Odoo.
 */
export type TikTokShopCredentials = {
  appKey: string;
  appSecret: string;
  accessToken: string;
  /** `shop_cipher` untuk API toko. */
  cipher: string;
};

export type TikTokOrder = {
  id: string;
  status?: string;
  /** detik epoch */
  create_time?: number;
  /** detik epoch; kosong untuk pesanan COD dan yang belum dibayar. */
  paid_time?: number;
  is_cod?: boolean;
};

/** `Get Order Detail` menerima paling banyak 50 nomor pesanan per panggilan. */
export const ORDER_BATCH = 50;

/**
 * Klien TikTok Shop Open API (versi 202309) untuk satu toko, memakai App yang
 * sama dengan konektor Odoo.
 *
 * Tanda tangan: HMAC-SHA256 (kunci App secret, hex) atas
 * `secret + path + key1value1key2value2… + body + secret`, dengan parameter
 * query diurutkan menurut nama, tanpa `sign` dan `access_token`. Access token
 * dikirim lewat header `x-tts-access-token`.
 */
export class TikTokClient {
  /** Jumlah panggilan HTTP; ikut batas 50 subrequest per invocation. */
  calls = 0;

  constructor(
    private readonly host: string,
    private readonly creds: TikTokShopCredentials,
    private readonly timeoutMs = 20_000,
  ) {}

  private async sign(base: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.creds.appSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const s = this.creds.appSecret;
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(s + base + s));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async get<T>(path: string, query: Record<string, string>): Promise<T> {
    const q: Record<string, string> = {
      ...query,
      app_key: this.creds.appKey,
      timestamp: String(Math.floor(Date.now() / 1000)),
      shop_cipher: this.creds.cipher,
    };
    const base = path + Object.keys(q).sort().map((k) => k + q[k]).join("");
    q.sign = await this.sign(base);
    const url = new URL(path, this.host);
    url.search = new URLSearchParams(q).toString();
    this.calls++;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { "content-type": "application/json", "x-tts-access-token": this.creds.accessToken },
    });
    const text = await res.text();
    let body: { code?: number; message?: string; data?: T };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new TikTokError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (body.code !== 0) throw new TikTokError(`${body.code}: ${body.message ?? ""}`, body.code);
    return body.data as T;
  }

  /** Detail pesanan (waktu dibuat, waktu bayar, COD); paling banyak 50. */
  async orders(ids: string[]): Promise<TikTokOrder[]> {
    if (ids.length === 0) return [];
    const data = await this.get<{ orders?: TikTokOrder[] }>("/order/202309/orders", { ids: ids.join(",") });
    return data.orders ?? [];
  }
}
