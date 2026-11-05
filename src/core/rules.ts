/**
 * Aturan murni (tanpa I/O) yang dipakai job perbaikan SO Shopee dan TikTok.
 */

/**
 * Bagi harga satu unit combo ke tiap grup combo, sebanding dengan Harga Combo
 * (`base_price`) grup itu — sama seperti `_get_combo_item_display_price()` di
 * Odoo 19. Bila semua `base_price` 0, harga dibagi rata. Hasil dibulatkan ke
 * rupiah; selisih pembulatan masuk ke grup terakhir, seperti Odoo.
 */
export function splitPrice(price: number, basePrices: number[]): number[] {
  if (basePrices.length === 0) return [];
  const total = basePrices.reduce((a, b) => a + b, 0);
  const shares = basePrices.map((b) =>
    Math.round(total ? (price * b) / total : price / basePrices.length),
  );
  const delta = price - shares.reduce((a, b) => a + b, 0);
  shares[shares.length - 1] = (shares[shares.length - 1] ?? 0) + delta;
  return shares;
}

/** Awalan nama kontak per marketplace: S = Shopee, T = TikTok Shop. */
export type Channel = "S" | "T";

const RENAMED = /^[ST]-\S+ \((.*)\)$/;

/**
 * Nama pembeli dari nama kontak: username Shopee, atau nama bawaan konektor
 * TikTok (API TikTok tidak memberikan username). Kontak yang sudah pernah
 * diganti namanya (`S-<no pesanan> (<nama>)`) dipakai ulang konektor untuk
 * pesanan berikutnya dari pembeli yang sama, jadi nama diambil dari dalam
 * kurung supaya tidak bertumpuk.
 */
export function buyerUsername(name: string): string {
  return RENAMED.exec(name)?.[1] ?? name;
}

/** Format nama kontak pesanan marketplace, sama dengan entri manual. */
export function contactName(orderRef: string, currentName: string, channel: Channel = "S"): string {
  return `${channel}-${orderRef} (${buyerUsername(currentName)})`;
}

/** Format `create_date` Odoo (UTC, tanpa zona). */
export function odooDatetime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Zona waktu toko (WIB); hari kerja dihitung di zona ini. */
const WIB_OFFSET_MS = 7 * 3600_000;

/**
 * Tanggal pembukuan pesanan: pesanan yang dibayar Sabtu (WIB) dicatat Senin
 * berikutnya pukul 00:00 WIB, dan yang dibayar Minggu pukul 00:01 WIB, supaya
 * masuk laporan hari kerja dan pesanan Sabtu tetap terurut lebih dulu. Hari
 * lain tidak berubah.
 */
export function bookingDate(paidAt: Date): Date {
  const wib = new Date(paidAt.getTime() + WIB_OFFSET_MS);
  const day = wib.getUTCDay(); // 0 = Minggu, 6 = Sabtu
  if (day !== 0 && day !== 6) return paidAt;
  const monday = Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate() + (day === 6 ? 2 : 1));
  return new Date(monday - WIB_OFFSET_MS + (day === 0 ? 60_000 : 0));
}
