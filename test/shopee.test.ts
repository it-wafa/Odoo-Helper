import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { odooDatetime } from "../src/core/rules";
import type { Env } from "../src/env";
import { runFixup } from "../src/jobs/fixup";
import { tokenKey, type ShopToken } from "../src/shopee/client";
import { FakeOdoo } from "./fake-odoo";
import { FakeShopee } from "./fake-shopee";

const E = env as unknown as Env;
const SHOP = 225736119;

let odoo: FakeOdoo;
let shopee: FakeShopee;
let uninstall: (() => void)[];

const now = () => odooDatetime(new Date());
const epoch = (s: string) => Date.parse(`${s.replace(" ", "T")}Z`) / 1000;

function order(id: number, ref: string, dateOrder: string, o: Partial<Record<string, unknown>> = {}) {
  return odoo.add("sale.order", {
    id,
    name: `SO/${id}`,
    state: "sale",
    locked: true,
    shopee_shop_id: 2,
    shopee_order_ref: ref,
    partner_id: 5000 + id,
    date_order: dateOrder,
    create_date: now(),
    ...o,
  });
}

/** Simpan token seperti hasil otorisasi, tanpa lewat callback. */
async function authorize(o: Partial<ShopToken> = {}) {
  shopee.validAccess.add("access-0");
  shopee.validRefresh.add("refresh-0");
  const token: ShopToken = {
    shopId: SHOP,
    accessToken: "access-0",
    refreshToken: "refresh-0",
    expiresAt: Date.now() + 4 * 3600_000,
    refreshedAt: Date.now(),
    ...o,
  };
  await E.SHOPEE_KV.put(tokenKey(SHOP), JSON.stringify(token));
}

async function storedToken(): Promise<ShopToken | null> {
  return E.SHOPEE_KV.get<ShopToken>(tokenKey(SHOP), "json");
}

beforeEach(async () => {
  odoo = new FakeOdoo();
  shopee = new FakeShopee(2052005, "test-partner-key");
  uninstall = [odoo.install("https://odoo.test"), shopee.install("https://shopee.test")];
  odoo.add("shopee.shop", { id: 2, name: "Toko Shopee #225736119", shop_identifier: SHOP });
  odoo.add("shopee.shop", { id: 1, name: "Toko lama", shop_identifier: 111 });
  await E.SHOPEE_KV.delete(tokenKey(SHOP));
});

afterEach(() => uninstall.reverse().forEach((u) => u()));

describe("Tanggal Order dari waktu bayar", () => {
  it("melewati langkah Shopee bila toko belum diotorisasi", async () => {
    order(1, "REF1", "2026-11-03 01:14:48");

    const r = await runFixup(E);

    expect(r.shopee).toBe("not_authorized");
    expect(r.errors).toEqual([]);
    expect(shopee.calls).toEqual([]);
    expect(odoo.get("sale.order", 1)!.date_order).toBe("2026-11-03 01:14:48");
  });

  it("mengganti Tanggal Order dengan pay_time, juga pada SO terkunci, seperti 261103APDXUBGY", async () => {
    await authorize();
    order(6678, "261103APDXUBGY", "2026-11-03 01:14:48");
    order(6679, "261103B4SM9F5A", "2026-11-03 05:31:52");
    order(6680, "BELUMBAYAR", "2026-11-03 05:40:00");
    order(6681, "TOKOLAIN", "2026-11-03 05:40:00", { shopee_shop_id: 1 });
    order(6682, "BATAL", "2026-11-03 05:40:00", { state: "cancel" });
    shopee.addOrder({ order_sn: "261103APDXUBGY", create_time: epoch("2026-11-03 01:14:48"), pay_time: epoch("2026-11-03 04:02:10") });
    // Dibayar tepat saat Tanggal Order: tidak perlu ditulis.
    shopee.addOrder({ order_sn: "261103B4SM9F5A", create_time: epoch("2026-11-03 05:31:00"), pay_time: epoch("2026-11-03 05:31:52") });
    shopee.addOrder({ order_sn: "BELUMBAYAR", create_time: epoch("2026-11-03 05:40:00") });

    const r = await runFixup(E);

    expect(r.errors).toEqual([]);
    expect(r.shopee).toBe("connected");
    expect(r.orderDates).toEqual({
      dryRun: false,
      changed: [{ order: "SO/6678", ref: "261103APDXUBGY", from: "2026-11-03 01:14:48", to: "2026-11-03 04:02:10" }],
    });
    expect(odoo.get("sale.order", 6678)!.date_order).toBe("2026-11-03 04:02:10");
    expect(odoo.get("sale.order", 6680)!.date_order).toBe("2026-11-03 05:40:00");
    // Hanya pesanan toko ini yang ditanyakan ke Shopee, dalam satu panggilan.
    const detail = shopee.calls.filter((c) => c.path === "/api/v2/order/get_order_detail");
    expect(detail).toHaveLength(1);
    expect(detail[0]!.query.order_sn_list!.split(",").sort()).toEqual(["261103APDXUBGY", "261103B4SM9F5A", "BELUMBAYAR"]);
    expect(detail[0]!.query.response_optional_fields).toBe("pay_time");

    // Putaran kedua tidak menulis lagi.
    const writes = odoo.writes().length;
    const r2 = await runFixup(E);
    expect(r2.orderDates.changed).toEqual([]);
    expect(odoo.writes().length).toBe(writes);
  });

  it("membiarkan SO yang dibuat sebelum SHOPEE_DATE_FROM", async () => {
    await authorize();
    order(1, "LAMA", "2026-11-03 01:00:00", { create_date: odooDatetime(new Date(Date.now() - 3600_000)) });
    order(2, "BARU", "2026-11-03 01:00:00");
    for (const sn of ["LAMA", "BARU"]) {
      shopee.addOrder({ order_sn: sn, create_time: epoch("2026-11-03 01:00:00"), pay_time: epoch("2026-11-03 02:00:00") });
    }

    const r = await runFixup({ ...E, SHOPEE_DATE_FROM: odooDatetime(new Date(Date.now() - 60_000)) });

    expect(r.orderDates.changed.map((c) => c.ref)).toEqual(["BARU"]);
    expect(odoo.get("sale.order", 1)!.date_order).toBe("2026-11-03 01:00:00");
  });

  it("mencatat pembayaran akhir pekan pada Senin 00:00 WIB bila WEEKEND_TO_MONDAY", async () => {
    await authorize();
    order(1, "SABTU", "2026-11-07 02:00:00");
    shopee.addOrder({ order_sn: "SABTU", create_time: epoch("2026-11-07 02:00:00"), pay_time: epoch("2026-11-07 02:01:00") });

    const r = await runFixup({ ...E, WEEKEND_TO_MONDAY: "1" });

    expect(r.orderDates.changed[0]?.to).toBe("2026-11-08 17:00:00");
    expect(odoo.get("sale.order", 1)!.date_order).toBe("2026-11-08 17:00:00");
    const r2 = await runFixup({ ...E, WEEKEND_TO_MONDAY: "1" });
    expect(r2.orderDates.changed).toEqual([]);
  });

  it("dry run bila SHOPEE_DATE_WRITE bukan 1", async () => {
    await authorize();
    order(1, "REF1", "2026-11-03 01:00:00");
    shopee.addOrder({ order_sn: "REF1", create_time: epoch("2026-11-03 01:00:00"), pay_time: epoch("2026-11-03 02:00:00") });

    const r = await runFixup({ ...E, SHOPEE_DATE_WRITE: "0" });

    expect(r.orderDates.dryRun).toBe(true);
    expect(r.orderDates.changed).toHaveLength(1);
    expect(odoo.writes()).toEqual([]);
  });

  it("memperbarui access token yang hampir habis dan menyimpan refresh token baru", async () => {
    await authorize({ expiresAt: Date.now() + 60_000 });
    order(1, "REF1", "2026-11-03 01:00:00");
    shopee.addOrder({ order_sn: "REF1", create_time: epoch("2026-11-03 01:00:00"), pay_time: epoch("2026-11-03 02:00:00") });

    const r = await runFixup(E);

    expect(r.errors).toEqual([]);
    const token = await storedToken();
    expect(token!.refreshToken).not.toBe("refresh-0");
    expect(token!.expiresAt).toBeGreaterThan(Date.now() + 3 * 3600_000);
    // Refresh token lama tidak berlaku lagi, jadi harus sudah diganti di KV.
    expect(shopee.validRefresh.has("refresh-0")).toBe(false);
    expect(odoo.get("sale.order", 1)!.date_order).toBe("2026-11-03 02:00:00");
  });

  it("access token yang ditolak diperbarui pada putaran berikutnya", async () => {
    await authorize();
    shopee.validAccess.delete("access-0");
    order(1, "REF1", "2026-11-03 01:00:00");
    shopee.addOrder({ order_sn: "REF1", create_time: epoch("2026-11-03 01:00:00"), pay_time: epoch("2026-11-03 02:00:00") });

    const r = await runFixup(E);
    expect(r.errors.map((e) => e.step)).toEqual(["order_date"]);
    expect((await storedToken())!.expiresAt).toBe(0);

    const r2 = await runFixup(E);
    expect(r2.errors).toEqual([]);
    expect(odoo.get("sale.order", 1)!.date_order).toBe("2026-11-03 02:00:00");
  });
});

describe("otorisasi toko", () => {
  it("/shopee/auth mengarahkan ke halaman otorisasi dengan tanda tangan dan callback", async () => {
    const res = await SELF.fetch("https://shopee.wafaindonesia.or.id/shopee/auth", { redirect: "manual" });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin + url.pathname).toBe("https://shopee.test/api/v2/shop/auth_partner");
    expect(url.searchParams.get("partner_id")).toBe("2052005");
    expect(url.searchParams.get("sign")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("redirect")).toBe("https://shopee.wafaindonesia.or.id/shopee/callback");
  });

  it("callback menukar code dan menyimpan token toko", async () => {
    const res = await SELF.fetch(`https://shopee.wafaindonesia.or.id/shopee/callback?code=good-code&shop_id=${SHOP}`);
    expect(res.status).toBe(200);
    const token = await storedToken();
    expect(token).toMatchObject({ shopId: SHOP, accessToken: "access-1", refreshToken: "refresh-1" });

    const status = await SELF.fetch("https://worker.test/admin/shopee", { headers: { "x-admin-key": "test-admin" } });
    const body = (await status.json()) as { data: Record<string, unknown> };
    expect(body.data.authorized).toBe(true);
    // Token tidak pernah dipulangkan.
    expect(JSON.stringify(body)).not.toContain("access-1");
    expect(JSON.stringify(body)).not.toContain("refresh-1");
  });

  it("callback menolak toko lain dan code yang salah", async () => {
    const other = await SELF.fetch("https://shopee.wafaindonesia.or.id/shopee/callback?code=good-code&shop_id=999");
    expect(other.status).toBe(400);
    const bad = await SELF.fetch(`https://shopee.wafaindonesia.or.id/shopee/callback?code=bad&shop_id=${SHOP}`);
    expect(bad.status).toBe(502);
    expect(await storedToken()).toBeNull();
  });

  it("/admin/shopee butuh kunci admin", async () => {
    const res = await SELF.fetch("https://worker.test/admin/shopee");
    expect(res.status).toBe(401);
  });
});
