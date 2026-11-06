import { bookingDate, contactName, odooDatetime, splitPrice, type Channel } from "../core/rules";
import { boolVar, idListVar, numberVar, type Env } from "../env";
import { idList, m2oId, OdooClient, type Domain, type Row } from "../odoo/client";
import { ORDER_DETAIL_BATCH, ShopeeClient, ShopeeError } from "../shopee/client";
import { ORDER_BATCH, TikTokClient } from "../tiktok/client";

export type FixupReport = {
  dryRun: boolean;
  since: string;
  /** Baris biaya Shopee pada SO terkonfirmasi yang harganya dijadikan 0. */
  feeLinesZeroed: number[];
  /** Baris biaya Shopee pada SO draf yang dihapus. */
  feeLinesDeleted: number[];
  combosSplit: {
    lineId: number;
    order: string;
    product: string;
    qty: number;
    price: number;
    children: { product: string; price: number }[];
  }[];
  /**
   * Baris combo yang tidak dipecah karena SO-nya sudah berisi komponen combo
   * sebagai baris biasa (mis. dientri manual). Perlu ditangani manual.
   */
  combosSkipped: { lineId: number; order: string; product: string }[];
  /** Baris combo yang sub-barisnya sudah ada tetapi harganya belum 0. */
  combosRepriced: number[];
  contactsRenamed: { partnerId: number; from: string; to: string }[];
  /**
   * Tanggal Order yang diganti dengan waktu bayar Shopee. `dryRun` langkah
   * ini juga mengikuti SHOPEE_DATE_WRITE.
   */
  orderDates: { dryRun: boolean; changed: { order: string; ref: string; from: string; to: string }[] };
  /** Keadaan koneksi Shopee: belum diisi kredensialnya, belum diotorisasi, atau tersambung. */
  shopee: "not_configured" | "not_authorized" | "connected";
  /**
   * Tanggal Order SO TikTok yang diganti dengan waktu bayar (COD: waktu
   * pesanan dibuat). `dryRun` langkah ini juga mengikuti TIKTOK_DATE_WRITE.
   */
  tiktokDates: { dryRun: boolean; changed: { order: string; ref: string; from: string; to: string }[] };
  /**
   * Keadaan koneksi TikTok: `idle` = tidak ada SO TikTok yang perlu diperiksa
   * (API tidak dipanggil), `not_configured` = kredensial toko di Odoo kosong.
   */
  tiktok: "idle" | "not_configured" | "connected";
  /** Tanggal Terjadwal pengiriman yang belum selesai, disamakan dengan Tanggal Order SO-nya. */
  scheduledDates: { picking: string; order: string; from: string; to: string }[];
  /** Masalah per langkah; langkah lain tetap dijalankan. */
  errors: { step: string; error: string }[];
  rpcCalls: number;
};

export function client(env: Env): OdooClient {
  return new OdooClient({
    url: env.ODOO_URL,
    db: env.ODOO_DB,
    login: env.ODOO_LOGIN,
    apiKey: env.ODOO_API_KEY,
  });
}

/**
 * Merapikan SO dari konektor Shopee Odoo. Pengganti tiga automation rule
 * berkode Python yang ditagih Odoo sebagai "Maintenance Kode Kustom":
 *
 * 1. Baris biaya Shopee (diskon, penyesuaian, ongkir) dijadikan 0, sehingga
 *    SO berisi harga barang saja seperti entri manual.
 * 2. Baris produk combo dipecah menjadi sub-baris komponennya. Konektor hanya
 *    menulis satu baris combo; tanpa sub-baris, pengiriman komponen tidak
 *    dibuat dan pendapatan tidak terbagi per produk.
 * 3. Kontak pembeli diberi nama `S-<no pesanan> (<username>)` (Shopee) atau
 *    `T-<no pesanan> (<nama>)` (TikTok).
 * 4. Tanggal Order diganti dengan waktu bayar, akhir pekan dipindah ke Senin.
 *
 * Setiap langkah membaca keadaan Odoo lebih dulu dan hanya mengubah yang
 * belum benar, jadi aman diulang dan tidak butuh penyimpanan sendiri.
 */
export async function runFixup(env: Env, opts: { dryRun?: boolean } = {}): Promise<FixupReport> {
  const dryRun = opts.dryRun ?? !boolVar(env.WRITE_ENABLED);
  const hours = numberVar(env.LOOKBACK_HOURS, 48);
  const since = odooDatetime(new Date(Date.now() - hours * 3600_000));
  const report: FixupReport = {
    dryRun,
    since,
    feeLinesZeroed: [],
    feeLinesDeleted: [],
    combosSplit: [],
    combosSkipped: [],
    combosRepriced: [],
    contactsRenamed: [],
    orderDates: { dryRun: dryRun || !boolVar(env.SHOPEE_DATE_WRITE), changed: [] },
    shopee: "not_configured",
    tiktokDates: { dryRun: dryRun || !boolVar(env.TIKTOK_DATE_WRITE), changed: [] },
    tiktok: "idle",
    scheduledDates: [],
    errors: [],
    rpcCalls: 0,
  };

  const odoo = client(env);
  try {
    await odoo.authenticate();
  } catch (err) {
    report.errors.push({ step: "authenticate", error: String(err) });
    report.rpcCalls = odoo.calls;
    return report;
  }

  // Baris SO Shopee yang masih boleh diubah: belum batal dan belum
  // difakturkan (harga baris yang sudah ditagih tidak boleh berubah). SO yang
  // terkunci tetap diproses: "Kunci Order Terkonfirmasi" aktif, jadi konektor
  // membuat SO Shopee dalam keadaan terkunci (lihat `whileUnlocked`).
  const openShopeeLine: Domain = [
    ["order_id.shopee_shop_id", "!=", false],
    ["order_id.create_date", ">=", since],
    ["order_id.state", "in", ["draft", "sent", "sale"]],
    ["qty_invoiced", "=", 0],
  ];

  // Panggilan HTTP di luar Odoo (Shopee, TikTok), untuk batas subrequest.
  const external = { calls: 0 };
  const steps: [string, () => Promise<void>][] = [
    ["fee_lines", () => fixFeeLines(odoo, env, openShopeeLine, dryRun, report)],
    ["combo_split", () => splitCombos(odoo, env, openShopeeLine, dryRun, report)],
    ["contact_rename", () => renameContacts(odoo, env, since, dryRun, report)],
    ["order_date", () => setOrderDates(odoo, env, since, report, external)],
    ["tiktok_order_date", () => setTikTokOrderDates(odoo, env, since, report, external)],
    ["scheduled_date", () => syncScheduledDates(odoo, env, since, report, external)],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (err) {
      report.errors.push({ step, error: String(err) });
    }
  }
  report.rpcCalls = odoo.calls;
  return report;
}

export function shopeeClient(env: Env): ShopeeClient | null {
  const partnerId = Number(env.SHOPEE_PARTNER_ID);
  const shopId = Number(env.SHOPEE_SHOP_ID);
  if (!partnerId || !env.SHOPEE_PARTNER_KEY || !shopId || !env.SHOPEE_KV) return null;
  return new ShopeeClient({
    host: env.SHOPEE_HOST,
    partnerId,
    partnerKey: env.SHOPEE_PARTNER_KEY,
    shopId,
    kv: env.SHOPEE_KV,
  });
}

/** Sisa jatah subrequest untuk langkah terakhir; batas paket gratis 50. */
const SUBREQUEST_BUDGET = 45;

async function fixFeeLines(
  odoo: OdooClient,
  env: Env,
  openShopeeLine: Domain,
  dryRun: boolean,
  report: FixupReport,
): Promise<void> {
  const feeIds = idListVar(env.FEE_PRODUCT_IDS);
  if (feeIds.length === 0) return;
  const lines = await odoo.searchRead(
    "sale.order.line",
    [...openShopeeLine, ["product_id", "in", feeIds], ["price_unit", "!=", 0]],
    ["state", "order_id"],
  );
  // Baris SO terkonfirmasi tidak bisa dihapus, jadi harganya dijadikan 0.
  const draft = lines.filter((l) => l.state !== "sale").map((l) => l.id as number);
  const confirmed = lines.filter((l) => l.state === "sale").map((l) => l.id as number);
  if (!dryRun) {
    await whileUnlocked(odoo, orderIds(lines), async () => {
      await odoo.unlink("sale.order.line", draft);
      await odoo.write("sale.order.line", confirmed, { price_unit: 0 });
    });
  }
  report.feeLinesDeleted = draft;
  report.feeLinesZeroed = confirmed;
}

async function splitCombos(
  odoo: OdooClient,
  env: Env,
  openShopeeLine: Domain,
  dryRun: boolean,
  report: FixupReport,
): Promise<void> {
  // Baris combo yang sudah dipecah berharga 0 (harga pindah ke sub-baris),
  // jadi `price_unit != 0` menyaring yang belum selesai.
  const lines = await odoo.searchRead(
    "sale.order.line",
    [
      ...openShopeeLine,
      ["product_id.type", "=", "combo"],
      ["price_unit", "!=", 0],
      ["product_uom_qty", ">", 0],
    ],
    ["order_id", "product_id", "product_template_id", "price_unit", "product_uom_qty", "sequence"],
  );
  if (lines.length === 0) return;

  // Sub-baris yang sudah ada berarti pemecahan sebelumnya berhenti setelah
  // membuat sub-baris tetapi sebelum mengenolkan harga combo: cukup harganya.
  const children = await odoo.searchRead(
    "sale.order.line",
    [
      ["linked_line_id", "in", lines.map((l) => l.id)],
      ["combo_item_id", "!=", false],
    ],
    ["linked_line_id"],
  );
  const alreadySplit = new Set(children.map((c) => m2oId(c.linked_line_id)));
  const repriced = lines.filter((l) => alreadySplit.has(l.id as number)).map((l) => l.id as number);
  const toSplit = lines.filter((l) => !alreadySplit.has(l.id as number));

  const templateIds = [...new Set(toSplit.map((l) => m2oId(l.product_template_id)).filter(isId))];
  const templates = byId(await odoo.read("product.template", templateIds, ["combo_ids"]));
  const comboIds = [...new Set([...templates.values()].flatMap((t) => idList(t.combo_ids)))];
  const combos = byId(await odoo.read("product.combo", comboIds, ["base_price", "combo_item_ids"]));
  // Setiap grup combo yang dipakai bundling Shopee berisi satu produk; bila
  // berisi lebih, produk pertama yang dipilih.
  const itemIds = [...combos.values()].map((c) => idList(c.combo_item_ids)[0]).filter(isId);
  const items = byId(await odoo.read("product.combo.item", itemIds, ["product_id"]));

  // Komponen yang sudah ada sebagai baris biasa berarti SO sudah diperbaiki
  // manual: memecah combo akan menggandakan nilai SO dan pengirimannya.
  const manual = await odoo.searchRead(
    "sale.order.line",
    [
      ["order_id", "in", orderIds(toSplit)],
      ["combo_item_id", "=", false],
      ["product_uom_qty", ">", 0],
    ],
    ["order_id", "product_id"],
  );
  const manualKey = new Set(manual.map((l) => `${m2oId(l.order_id)}:${m2oId(l.product_id)}`));

  const marketplacePrice = await marketplacePrices(
    odoo,
    numberVar(env.COMBO_PRICELIST_ID, 0),
    [...items.values()].map((i) => m2oId(i.product_id)).filter(isId),
  );

  const vals: Row[] = [];
  const split: number[] = [];
  for (const line of toSplit) {
    const groups = idList(templates.get(m2oId(line.product_template_id) ?? 0)?.combo_ids)
      .map((id) => combos.get(id))
      .filter((c): c is Row => c !== undefined);
    const picked = groups.map((g) => items.get(idList(g.combo_item_ids)[0] ?? 0));
    if (groups.length === 0 || picked.some((i) => i === undefined)) {
      report.errors.push({
        step: "combo_split",
        error: `baris ${line.id} (${label(line.product_id)}): grup combo kosong atau tidak terbaca`,
      });
      continue;
    }
    if (picked.some((item) => manualKey.has(`${m2oId(line.order_id)}:${m2oId(item!.product_id)}`))) {
      report.combosSkipped.push({
        lineId: line.id as number,
        order: label(line.order_id),
        product: label(line.product_id),
      });
      continue;
    }
    const price = line.price_unit as number;
    // Bobot: harga marketplace komponen; tanpa harga itu, Harga Combo Odoo.
    const shares = splitPrice(
      price,
      groups.map((g, i) => marketplacePrice.get(m2oId(picked[i]!.product_id) ?? 0) || (g.base_price as number) || 0),
    );
    const childVals = picked.map((item, i) => ({
      order_id: m2oId(line.order_id),
      product_id: m2oId(item!.product_id),
      product_uom_qty: line.product_uom_qty,
      price_unit: shares[i],
      combo_item_id: item!.id,
      linked_line_id: line.id,
      sequence: line.sequence,
    }));
    vals.push(...childVals);
    split.push(line.id as number);
    report.combosSplit.push({
      lineId: line.id as number,
      order: label(line.order_id),
      product: label(line.product_id),
      qty: line.product_uom_qty as number,
      price,
      children: picked.map((item, i) => ({ product: label(item!.product_id), price: shares[i] ?? 0 })),
    });
  }

  if (!dryRun && split.length + repriced.length > 0) {
    // Sub-baris dibuat lebih dulu: bila langkah berikutnya gagal, putaran
    // berikutnya melihat sub-barisnya dan hanya mengenolkan harga combo.
    // Urutan sebaliknya bisa meninggalkan combo berharga 0 tanpa sub-baris,
    // yang tidak bisa dipecah lagi karena harganya sudah hilang.
    const touched = new Set([...split, ...repriced]);
    await whileUnlocked(odoo, orderIds(lines.filter((l) => touched.has(l.id as number))), async () => {
      await odoo.create("sale.order.line", vals);
      await odoo.write("sale.order.line", [...split, ...repriced], { price_unit: 0 });
    });
  }
  report.combosRepriced = repriced;
}

/** Field SO per marketplace, dengan awalan nama kontaknya. */
const CHANNELS: { channel: Channel; shop: string; ref: string }[] = [
  { channel: "S", shop: "shopee_shop_id", ref: "shopee_order_ref" },
  { channel: "T", shop: "tiktok_shop_id", ref: "tiktok_order_ref" },
];

/**
 * Harga tetap per produk dari pricelist marketplace. Harga Combo Odoo dihitung
 * dari harga jual, yang bisa jauh dari harga marketplace (TTG 35.000 vs 62.000,
 * AQH5 0 vs 47.500), sehingga pendapatan per produk meleset bila dipakai sebagai
 * bobot. Hanya aturan harga tetap per produk yang dibaca.
 */
async function marketplacePrices(
  odoo: OdooClient,
  pricelistId: number,
  productIds: number[],
): Promise<Map<number, number>> {
  if (!pricelistId || productIds.length === 0) return new Map();
  const products = await odoo.read("product.product", productIds, ["product_tmpl_id"]);
  const templateIds = [...new Set(products.map((p) => m2oId(p.product_tmpl_id)).filter(isId))];
  const rules = await odoo.searchRead(
    "product.pricelist.item",
    [
      ["pricelist_id", "=", pricelistId],
      ["applied_on", "=", "1_product"],
      ["compute_price", "=", "fixed"],
      ["product_tmpl_id", "in", templateIds],
    ],
    ["product_tmpl_id", "fixed_price"],
  );
  const byTemplate = new Map(rules.map((r) => [m2oId(r.product_tmpl_id), r.fixed_price as number]));
  return new Map(products.map((p) => [p.id as number, byTemplate.get(m2oId(p.product_tmpl_id)) ?? 0]));
}

async function renameContacts(
  odoo: OdooClient,
  env: Env,
  since: string,
  dryRun: boolean,
  report: FixupReport,
): Promise<void> {
  // Pembeli yang memesan lagi memakai kontak yang sama; nama mengikuti pesanan
  // terbarunya. Tanpa ini dua pesanan saling menimpa nama di setiap putaran.
  const latestRef = new Map<number, { ref: string; channel: Channel }>();
  for (const { channel, shop, ref } of CHANNELS) {
    const orders = await odoo.searchRead(
      "sale.order",
      [
        [shop, "!=", false],
        ["create_date", ">=", since],
        ["state", "!=", "cancel"],
        [ref, "!=", false],
      ],
      [ref, "partner_id"],
      { order: "id asc" },
    );
    for (const o of orders) {
      const pid = m2oId(o.partner_id);
      if (pid) latestRef.set(pid, { ref: o[ref] as string, channel });
    }
  }
  if (latestRef.size === 0) return;
  const partners = await odoo.read("res.partner", [...latestRef.keys()], ["name"]);
  const max = numberVar(env.MAX_RENAMES_PER_RUN, 20);
  for (const p of partners) {
    const from = (p.name as string) || "";
    const { ref, channel } = latestRef.get(p.id as number)!;
    const to = contactName(ref, from, channel);
    if (from === to) continue;
    if (report.contactsRenamed.length >= max) break;
    if (!dryRun) await odoo.write("res.partner", [p.id as number], { name: to });
    report.contactsRenamed.push({ partnerId: p.id as number, from, to });
  }
}

/**
 * Odoo menolak perubahan harga, produk, dan qty baris pada SO terkunci. SO
 * yang terkunci dibuka sebentar lalu dikunci lagi, juga bila penulisan gagal,
 * supaya tidak ada SO yang tertinggal terbuka.
 */
async function whileUnlocked(odoo: OdooClient, ids: number[], fn: () => Promise<void>): Promise<void> {
  const locked = (await odoo.read("sale.order", ids, ["locked"]))
    .filter((o) => o.locked === true)
    .map((o) => o.id as number);
  await odoo.action("sale.order", "action_unlock", locked);
  try {
    await fn();
  } finally {
    await odoo.action("sale.order", "action_lock", locked);
  }
}

function orderIds(lines: Row[]): number[] {
  return [...new Set(lines.map((l) => m2oId(l.order_id)).filter(isId))];
}

/**
 * Tanggal Order dari konektor adalah waktu pesanan dibuat di Shopee, padahal
 * pesanan baru ditarik setelah dibayar. Tanggal Order diganti dengan waktu
 * bayar (`pay_time`) supaya laporan penjualan jatuh di hari pembayaran.
 * Dengan WEEKEND_TO_MONDAY, pembayaran Sabtu dicatat Senin 00:00 WIB dan
 * Minggu Senin 00:01 WIB.
 * Konektor memperbarui SO tiap jam; bila tanggalnya tertimpa, putaran
 * berikutnya mengembalikannya.
 *
 * Penulisan Tanggal Order tidak terhalang kunci SO: Odoo hanya melindungi
 * field baris pada SO terkunci.
 */
async function setOrderDates(
  odoo: OdooClient,
  env: Env,
  since: string,
  report: FixupReport,
  external: { calls: number },
): Promise<void> {
  const shopee = shopeeClient(env);
  if (!shopee) return;
  try {
    await setShopeeOrderDates(odoo, env, since, report, shopee, external);
  } finally {
    external.calls += shopee.calls;
  }
}

async function setShopeeOrderDates(
  odoo: OdooClient,
  env: Env,
  since: string,
  report: FixupReport,
  shopee: ShopeeClient,
  external: { calls: number },
): Promise<void> {
  const accessToken = await shopee.accessToken();
  report.shopee = accessToken ? "connected" : "not_authorized";
  if (!accessToken) return;

  const orders = await odoo.searchRead(
    "sale.order",
    [
      ["shopee_shop_id.shop_identifier", "=", Number(env.SHOPEE_SHOP_ID)],
      // SO sebelum SHOPEE_DATE_FROM sengaja dibiarkan dengan tanggal lamanya.
      ["create_date", ">=", env.SHOPEE_DATE_FROM && env.SHOPEE_DATE_FROM > since ? env.SHOPEE_DATE_FROM : since],
      ["state", "=", "sale"],
      ["shopee_order_ref", "!=", false],
    ],
    ["name", "shopee_order_ref", "date_order"],
    { order: "id asc" },
  );
  for (let i = 0; i < orders.length; i += ORDER_DETAIL_BATCH) {
    const batch = orders.slice(i, i + ORDER_DETAIL_BATCH);
    let details;
    try {
      details = await shopee.orderDetails(accessToken, batch.map((o) => o.shopee_order_ref as string));
    } catch (err) {
      // Access token bisa dicabut sebelum waktunya (mis. otorisasi ulang);
      // putaran berikutnya memperbaruinya dengan refresh token. Shopee
      // menulisnya `invalid_acceess_token`.
      if (err instanceof ShopeeError && /invalid_acc?e+ss_token/.test(err.code ?? "")) await shopee.expireToken();
      throw err;
    }
    const paidAt = new Map(
      details.filter((d) => d.pay_time).map((d) => {
        const paid = new Date(d.pay_time! * 1000);
        return [d.order_sn, odooDatetime(boolVar(env.WEEKEND_TO_MONDAY) ? bookingDate(paid) : paid)];
      }),
    );
    for (const o of batch) {
      const to = paidAt.get(o.shopee_order_ref as string);
      if (!to || to === o.date_order) continue;
      if (!report.orderDates.dryRun) {
        if (odoo.calls + external.calls + shopee.calls >= SUBREQUEST_BUDGET) return;
        await odoo.write("sale.order", [o.id as number], { date_order: to });
      }
      report.orderDates.changed.push({
        order: String(o.name),
        ref: String(o.shopee_order_ref),
        from: String(o.date_order),
        to,
      });
    }
  }
}

/**
 * Sama dengan `setOrderDates`, untuk SO dari konektor TikTok Odoo. Waktu bayar
 * diambil dari TikTok Shop API (`paid_time`); pesanan COD tidak punya waktu
 * bayar, jadi dipakai waktu pesanan dibuat. Kredensial dibaca dari
 * `tiktok.shop` di Odoo (App yang sama dengan konektor), dan API hanya
 * dipanggil bila ada SO TikTok yang perlu diperiksa.
 */
async function setTikTokOrderDates(
  odoo: OdooClient,
  env: Env,
  since: string,
  report: FixupReport,
  external: { calls: number },
): Promise<void> {
  const from = env.TIKTOK_DATE_FROM && env.TIKTOK_DATE_FROM > since ? env.TIKTOK_DATE_FROM : since;
  const orders = await odoo.searchRead(
    "sale.order",
    [
      ["tiktok_shop_id", "!=", false],
      ["create_date", ">=", from],
      ["state", "=", "sale"],
      ["tiktok_order_ref", "!=", false],
    ],
    ["name", "tiktok_order_ref", "date_order", "tiktok_shop_id"],
    { order: "id asc" },
  );
  if (orders.length === 0) return;

  const shopIds = [...new Set(orders.map((o) => m2oId(o.tiktok_shop_id)).filter(isId))];
  const shops = await odoo.read("tiktok.shop", shopIds, ["app_key", "app_secret", "access_token", "tiktok_cipher"]);
  report.tiktok = "connected";
  for (const shop of shops) {
    if (!shop.app_key || !shop.app_secret || !shop.access_token || !shop.tiktok_cipher) {
      report.tiktok = "not_configured";
      continue;
    }
    const tiktok = new TikTokClient(env.TIKTOK_HOST, {
      appKey: String(shop.app_key),
      appSecret: String(shop.app_secret),
      accessToken: String(shop.access_token),
      cipher: String(shop.tiktok_cipher),
    });
    try {
      const own = orders.filter((o) => m2oId(o.tiktok_shop_id) === shop.id);
      for (let i = 0; i < own.length; i += ORDER_BATCH) {
        if (odoo.calls + external.calls + tiktok.calls >= SUBREQUEST_BUDGET) return;
        const batch = own.slice(i, i + ORDER_BATCH);
        const details = await tiktok.orders(batch.map((o) => String(o.tiktok_order_ref)));
        const booked = new Map<string, string>();
        for (const d of details) {
          const at = d.paid_time ?? (d.is_cod ? d.create_time : undefined);
          if (!at) continue; // belum dibayar
          const t = new Date(at * 1000);
          booked.set(String(d.id), odooDatetime(boolVar(env.WEEKEND_TO_MONDAY) ? bookingDate(t) : t));
        }
        for (const o of batch) {
          const to = booked.get(String(o.tiktok_order_ref));
          if (!to || to === o.date_order) continue;
          if (!report.tiktokDates.dryRun) {
            if (odoo.calls + external.calls + tiktok.calls >= SUBREQUEST_BUDGET) return;
            await odoo.write("sale.order", [o.id as number], { date_order: to });
          }
          report.tiktokDates.changed.push({
            order: String(o.name),
            ref: String(o.tiktok_order_ref),
            from: String(o.date_order),
            to,
          });
        }
      }
    } finally {
      external.calls += tiktok.calls;
    }
  }
}

/**
 * Tanggal Terjadwal pengiriman dibuat dari Tanggal Order asli konektor dan tidak
 * ikut berubah saat Tanggal Order diganti. Disamakan supaya gudang melihat jadwal
 * yang sama dengan pesanannya (pesanan akhir pekan dijadwalkan Senin). Hanya
 * pengiriman yang belum selesai/batal: Odoo menolak mengubah yang sudah selesai,
 * dan realisasinya tercatat di Tanggal Efektif. Mengikuti batas tanggal dan
 * sakelar tulis marketplace-nya, karena SO di luar itu tetap bertanggal lama.
 */
async function syncScheduledDates(
  odoo: OdooClient,
  env: Env,
  since: string,
  report: FixupReport,
  external: { calls: number },
): Promise<void> {
  const channels = [
    ...(shopeeClient(env)
      ? [{ shop: "shopee_shop_id", from: env.SHOPEE_DATE_FROM, dryRun: report.orderDates.dryRun }]
      : []),
    { shop: "tiktok_shop_id", from: env.TIKTOK_DATE_FROM, dryRun: report.tiktokDates.dryRun },
  ];
  for (const { shop, from, dryRun } of channels) {
    const pickings = await odoo.searchRead(
      "stock.picking",
      [
        [`sale_id.${shop}`, "!=", false],
        ["sale_id.create_date", ">=", from && from > since ? from : since],
        ["sale_id.state", "=", "sale"],
        ["state", "in", ["draft", "waiting", "confirmed", "assigned"]],
      ],
      ["name", "scheduled_date", "sale_id"],
      { order: "id asc" },
    );
    if (pickings.length === 0) continue;
    const orders = byId(
      await odoo.read("sale.order", [...new Set(pickings.map((p) => m2oId(p.sale_id)).filter(isId))], ["date_order"]),
    );
    for (const p of pickings) {
      const to = orders.get(m2oId(p.sale_id) ?? 0)?.date_order as string | undefined;
      if (!to || to === p.scheduled_date) continue;
      if (!dryRun) {
        if (odoo.calls + external.calls >= SUBREQUEST_BUDGET) return;
        await odoo.write("stock.picking", [p.id as number], { scheduled_date: to });
      }
      report.scheduledDates.push({
        picking: String(p.name),
        order: label(p.sale_id),
        from: String(p.scheduled_date),
        to,
      });
    }
  }
}

function byId(rows: Row[]): Map<number, Row> {
  return new Map(rows.map((r) => [r.id as number, r]));
}

function isId(v: number | undefined): v is number {
  return typeof v === "number";
}

function label(m2o: unknown): string {
  return Array.isArray(m2o) ? String(m2o[1]) : "";
}

/** Ringkas untuk log: hanya dicatat bila ada perubahan atau galat. */
export function hasActivity(r: FixupReport): boolean {
  return (
    r.feeLinesZeroed.length +
      r.feeLinesDeleted.length +
      r.combosSplit.length +
      r.combosSkipped.length +
      r.combosRepriced.length +
      r.contactsRenamed.length +
      r.orderDates.changed.length +
      r.tiktokDates.changed.length +
      r.scheduledDates.length +
      r.errors.length >
    0
  );
}
