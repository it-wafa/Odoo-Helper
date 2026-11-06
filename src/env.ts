export type Env = {
  // vars (wrangler.jsonc)
  ODOO_URL: string;
  ODOO_DB: string;
  /** id product.product baris biaya Shopee, dipisah koma. */
  FEE_PRODUCT_IDS: string;
  LOOKBACK_HOURS: string;
  MAX_RENAMES_PER_RUN: string;
  /** "1" = perubahan ditulis ke Odoo; selain itu dry run. */
  WRITE_ENABLED: string;
  /** id pricelist harga marketplace; bobot pembagian harga combo. Kosong = Harga Combo saja. */
  COMBO_PRICELIST_ID?: string;
  /** Shopee Open API: https://partner.shopeemobile.com (live). */
  SHOPEE_HOST: string;
  /** Toko yang diotorisasi; callback otorisasi dari toko lain ditolak. */
  SHOPEE_SHOP_ID: string;
  /** "1" = Tanggal Order ditulis dari waktu bayar Shopee; selain itu dry run. */
  SHOPEE_DATE_WRITE: string;
  /** `create_date` SO paling awal (UTC, format Odoo) yang Tanggal Order-nya diganti. */
  SHOPEE_DATE_FROM?: string;
  /** "1" = pesanan yang dibayar Sabtu (WIB) bertanggal Senin 00:00 WIB, Minggu Senin 00:01 WIB. */
  WEEKEND_TO_MONDAY?: string;
  /** TikTok Shop Open API: https://open-api.tiktokglobalshop.com. Kredensial dibaca dari `tiktok.shop` Odoo. */
  TIKTOK_HOST: string;
  /** "1" = Tanggal Order SO TikTok ditulis dari waktu bayar; selain itu dry run. */
  TIKTOK_DATE_WRITE: string;
  /** `create_date` SO TikTok paling awal (UTC, format Odoo) yang Tanggal Order-nya diganti. */
  TIKTOK_DATE_FROM?: string;

  /** Tag rilis (vX.Y.Z), diisi pipeline lewat `wrangler deploy --var VERSION:…`. Kosong = deploy manual. */
  VERSION?: string;

  // bindings
  /** Token toko Shopee (refresh token berganti setiap dipakai). */
  SHOPEE_KV: KVNamespace;

  // secrets (wrangler secret put)
  ODOO_LOGIN: string;
  ODOO_API_KEY: string;
  ADMIN_API_KEY: string;
  /** Kosong = langkah Shopee dilewati. */
  SHOPEE_PARTNER_ID?: string;
  SHOPEE_PARTNER_KEY?: string;
};

export type AppBindings = { Bindings: Env };

export function numberVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function boolVar(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function idListVar(value: string | undefined): number[] {
  return (value ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}
