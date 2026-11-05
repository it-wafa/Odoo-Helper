# wafa-shopee-odoo

Merapikan Sales Order yang dibuat konektor Shopee (`sale_shopee`) dan TikTok
Shop (`sale_tiktok`) bawaan Odoo di `wafa-indonesia.odoo.com`. Worker ini menggantikan tiga automation rule
berkode Python, karena Odoo menagih kode semacam itu sebagai "Maintenance Kode
Kustom" (per 100 baris kode). Kode yang memanggil External API dari luar Odoo
tidak dihitung.

Setiap menit, SO yang dibuat dalam `LOOKBACK_HOURS` terakhir diperiksa. Baris
biaya dan pecah combo baru berlaku untuk Shopee; nama kontak dan Tanggal Order
untuk Shopee dan TikTok:

| Langkah | Masalah dari konektor | Perbaikan |
| --- | --- | --- |
| Baris biaya | Konektor menambah baris Shopee Order Discount, Amount Adjustment, dan Shipping, sehingga total SO = yang dibayar pembeli | Harga baris dijadikan 0 (SO terkonfirmasi) atau baris dihapus (SO draf). SO berisi harga barang saja, sama seperti entri manual |
| Pecah combo | Produk combo (mis. `CB-BT1-5`) masuk sebagai satu baris tanpa sub-baris. Pengiriman komponen tidak dibuat dan pendapatan tidak terbagi per buku | Sub-baris komponen dibuat (`combo_item_id`, `linked_line_id`) dengan harga dibagi sebanding Harga Combo tiap grup, lalu harga baris combo dijadikan 0. Karena SO sudah terkonfirmasi, Odoo menambah pengiriman komponennya sendiri |
| Nama kontak | Kontak bernama username Shopee, atau nama bawaan konektor TikTok, saja | Diganti menjadi `S-<no pesanan> (<username>)` (Shopee) atau `T-<no pesanan> (<nama>)` (TikTok; API TikTok tidak memberikan username, jadi nama bawaan konektor yang dipakai). Pembeli yang memesan lagi memakai kontak yang sama, dan namanya mengikuti pesanan terbaru |
| Tanggal Order | Tanggal Order = waktu pesanan dibuat, padahal pesanan baru ditarik setelah dibayar. Pesanan yang dibayar belakangan tercatat di hari (atau bulan) sebelumnya | Diganti dengan waktu bayar: `pay_time` dari Shopee Open API, `paid_time` dari TikTok Shop API (COD: waktu pesanan dibuat). Dibayar Sabtu → Senin 00:00 WIB, Minggu → Senin 00:01 WIB. Konektor memperbarui SO tiap jam; bila tanggalnya tertimpa, putaran berikutnya mengembalikannya |

SO yang batal atau barisnya sudah difakturkan tidak disentuh. SO yang terkunci
("Kunci Order Terkonfirmasi" aktif, jadi SO Shopee terkunci sejak dibuat) dibuka
sebentar, dirapikan, lalu dikunci lagi.

Satu-satunya penyimpanan adalah token toko Shopee di Workers KV (`SHOPEE_KV`),
karena refresh token Shopee berganti setiap dipakai. Selebihnya tanpa
penyimpanan: setiap langkah membaca keadaan Odoo lebih dulu dan hanya mengubah
yang belum benar, jadi aman diulang dan putaran yang terlewat dikejar putaran
berikutnya.

## Tech stack

Cloudflare Workers, Hono, TypeScript, Cron Triggers. Paket dikelola dengan Bun;
test memakai Vitest dan `@cloudflare/vitest-plugin`, dengan Odoo tiruan yang
mengevaluasi domain (`test/fake-odoo.ts`) dan Shopee tiruan yang memeriksa tanda
tangan HMAC (`test/fake-shopee.ts`). Klien JSON-RPC-nya setara dengan
klien Go di SIFA (`server/internal/odoo/client.go`).

## Konfigurasi

Vars ada di `wrangler.jsonc`:

| Var | Default | Arti |
| --- | --- | --- |
| `ODOO_URL` | `https://wafa-indonesia.odoo.com` | Alamat Odoo |
| `ODOO_DB` | kosong | Nama database; samakan dengan `ODOO_DB` di server SIFA |
| `FEE_PRODUCT_IDS` | `953,652,651` | id `product.product` baris biaya Shopee (cek di Pengaturan → Teknis → External Identifiers, `sale_shopee.default_*_product`) |
| `LOOKBACK_HOURS` | `48` | Rentang umur SO yang diperiksa |
| `MAX_RENAMES_PER_RUN` | `20` | Batas ganti nama kontak per putaran |
| `WRITE_ENABLED` | `0` | `0` = dry run, rencana perubahan hanya dicatat ke log |
| `SHOPEE_HOST` | `https://partner.shopeemobile.com` | Shopee Open API (live) |
| `SHOPEE_SHOP_ID` | `225736119` | Toko yang boleh dihubungkan; callback dari toko lain ditolak |
| `SHOPEE_DATE_WRITE` | `0` | `1` = Tanggal Order ditulis; selain itu dry run langkah ini saja |
| `SHOPEE_DATE_FROM` | `2026-11-05 02:07:00` | SO yang dibuat sebelum waktu ini (UTC) tidak diubah Tanggal Order-nya |
| `WEEKEND_TO_MONDAY` | `1` | Pesanan yang dibayar Sabtu (WIB) bertanggal Senin berikutnya 00:00 WIB, Minggu 00:01 WIB |
| `TIKTOK_HOST` | `https://open-api.tiktokglobalshop.com` | TikTok Shop Open API |
| `TIKTOK_DATE_WRITE` | `1` | `1` = Tanggal Order SO TikTok ditulis; selain itu dry run langkah ini saja |
| `TIKTOK_DATE_FROM` | kosong | Opsional: SO TikTok yang dibuat sebelum waktu ini (UTC) tidak diubah Tanggal Order-nya |

Secrets (`wrangler secret put <NAMA>`):

| Secret | Asal |
| --- | --- |
| `ODOO_LOGIN` | Login user Odoo pemilik API key |
| `ODOO_API_KEY` | Odoo → Preferensi → Keamanan Akun → Kunci API Baru. Buat kunci tersendiri, terpisah dari kunci SIFA |
| `ADMIN_API_KEY` | Dibuat sendiri, untuk `/admin/*` |
| `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY` | Shopee Open Platform → App List → Wafa Shopee and Odoo → Live Partner_id / Live API Partner Key. Kunci live punya masa berlaku (lihat konsol); perbarui keduanya sebelum habis. Kosong = langkah Tanggal Order dilewati |

User Odoo-nya butuh hak tulis Penjualan (baris SO) dan Kontak, serta hak baca
toko TikTok (`tiktok.shop`): App key, App secret, access token, dan shop cipher
TikTok dibaca dari sana pada putaran yang punya SO TikTok, bukan disimpan
sebagai secret Worker. Odoo yang memperbarui access token; Worker tidak pernah
me-refresh-nya.

Untuk pengembangan lokal, salin `.dev.vars.example` menjadi `.dev.vars`.

## Endpoint

| Endpoint | Guna |
| --- | --- |
| `GET /health` | Konfigurasi aktif (tanpa memanggil Odoo) |
| `POST /admin/run` | Jalankan sekarang, mengikuti `WRITE_ENABLED`. Butuh header `x-admin-key` |
| `POST /admin/run?dry=1` | Laporan rencana perubahan tanpa menulis ke Odoo |
| `GET /shopee/auth` | Buka di browser untuk menghubungkan toko: login sebagai penjual, setujui. Otorisasi berlaku sekitar 1 tahun |
| `GET /shopee/callback` | Tujuan kembali dari Shopee; menukar `code` dengan token dan menyimpannya di KV |
| `GET /admin/shopee` | Status otorisasi dan masa berlaku access token (token tidak ditampilkan) |

Laporan berisi baris biaya yang dinolkan/dihapus, combo yang dipecah beserta
pembagian harganya, kontak yang diganti namanya, galat per langkah, dan jumlah
panggilan RPC. Paket gratis Workers membatasi 50 subrequest per invocation;
satu putaran memakai sekitar 12 panggilan ditambah satu per kontak yang
diganti namanya.

## Perintah

```bash
bun install
bun run dev        # wrangler dev
bun run test       # vitest (lewat Node, bukan Bun)
bun run typecheck
bun run deploy
```

## Menyalakan

1. Isi `ODOO_DB` di `wrangler.jsonc`.
2. `wrangler secret put ODOO_LOGIN`, `ODOO_API_KEY`, `ADMIN_API_KEY`, lalu
   `bun run deploy`. `WRITE_ENABLED` masih `0`.
3. `POST /admin/run?dry=1`: pastikan autentikasi berhasil (`errors` kosong).
   Selama automation rule lama masih aktif, laporannya biasanya kosong.
4. Ubah `WRITE_ENABLED` menjadi `1`, lalu deploy.
5. Di Odoo, nonaktifkan dulu tiga automation rule `[CUSTOM]` Shopee. Tunggu
   satu pesanan Shopee masuk (termasuk bundling bila ada) dan pastikan Worker
   merapikannya (lihat log Worker atau `POST /admin/run?dry=1` sebelum cron
   berikutnya).
6. Hapus ketiga automation rule beserta server action "Jalankan Kode"-nya,
   lalu minta Account Manager Odoo membatalkan quotation upsell "Maintenance
   Kode Kustom".

Tanggal Order dari waktu bayar:

1. Isi secret `SHOPEE_PARTNER_ID` dan `SHOPEE_PARTNER_KEY`, lalu deploy
   (`SHOPEE_DATE_WRITE` masih `0`).
2. Buka `https://shopee.wafaindonesia.or.id/shopee/auth` dan setujui sebagai
   penjual toko 225736119. Cek `GET /admin/shopee`.
3. `POST /admin/run?dry=1`: periksa `orderDates.changed` (Tanggal Order lama →
   waktu bayar).
4. Ubah `SHOPEE_DATE_WRITE` menjadi `1`, lalu deploy.

Galat dicatat lewat `console.error` dengan `at: "fixup"` dan terlihat di
Workers Logs. Pasang notifikasi dari Cloudflare bila ingin diberi tahu saat
Worker gagal.
