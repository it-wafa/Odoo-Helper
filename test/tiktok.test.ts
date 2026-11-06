import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { odooDatetime } from "../src/core/rules";
import type { Env } from "../src/env";
import { runFixup } from "../src/jobs/fixup";
import { FakeOdoo } from "./fake-odoo";
import { FakeTikTok } from "./fake-tiktok";

const E = env as unknown as Env;
const SECRET = "tt-secret-test";
const TOKEN = "tt-access-token-test";

let odoo: FakeOdoo;
let tiktok: FakeTikTok;
let uninstall: (() => void)[];

const now = () => odooDatetime(new Date());
const epoch = (s: string) => Date.parse(`${s.replace(" ", "T")}Z`) / 1000;

function order(id: number, ref: string, dateOrder: string, o: Partial<Record<string, unknown>> = {}) {
  odoo.add("res.partner", { id: 5000 + id, name: `Pembeli ${id}` });
  return odoo.add("sale.order", {
    id,
    name: `SO/${id}`,
    state: "sale",
    locked: true,
    tiktok_shop_id: 1,
    tiktok_order_ref: ref,
    partner_id: 5000 + id,
    date_order: dateOrder,
    create_date: now(),
    ...o,
  });
}

beforeEach(() => {
  odoo = new FakeOdoo();
  tiktok = new FakeTikTok("tt-app-key", SECRET, TOKEN, "tt-cipher");
  uninstall = [odoo.install("https://odoo.test"), tiktok.install("https://tiktok.test")];
  odoo.add("tiktok.shop", {
    id: 1,
    name: "Wafa Indonesia Official",
    app_key: "tt-app-key",
    app_secret: SECRET,
    access_token: TOKEN,
    tiktok_cipher: "tt-cipher",
  });
});

afterEach(() => uninstall.reverse().forEach((u) => u()));

describe("Tanggal Order TikTok", () => {
  it("tidak memanggil TikTok dan tidak membaca kredensial bila tidak ada SO TikTok", async () => {
    const r = await runFixup(E);

    expect(r.errors).toEqual([]);
    expect(r.tiktok).toBe("idle");
    expect(tiktok.calls).toEqual([]);
    expect(odoo.calls.some((c) => c.model === "tiktok.shop")).toBe(false);
  });

  it("memakai waktu bayar, waktu dibuat untuk COD, dan aturan akhir pekan", async () => {
    order(1, "586981877055325743", "2026-11-05 01:58:22"); // dibayar Kamis
    order(2, "586954772163626642", "2026-11-03 19:51:45"); // COD
    order(3, "586000000000000001", "2026-11-07 02:00:00"); // dibayar Sabtu
    order(4, "586000000000000002", "2026-11-08 02:00:00"); // dibayar Minggu
    order(5, "586000000000000003", "2026-11-05 03:00:00"); // belum dibayar
    order(6, "586000000000000004", "2026-11-05 03:00:00", { state: "cancel" });
    order(7, "586000000000000005", "2026-11-05 04:00:00"); // sudah benar
    tiktok.addOrder({ id: "586981877055325743", status: "AWAITING_COLLECTION", create_time: epoch("2026-11-05 01:58:22"), paid_time: epoch("2026-11-05 02:00:10") });
    tiktok.addOrder({ id: "586954772163626642", status: "IN_TRANSIT", create_time: epoch("2026-11-03 19:51:45"), is_cod: true });
    tiktok.addOrder({ id: "586000000000000001", status: "AWAITING_SHIPMENT", create_time: epoch("2026-11-07 02:00:00"), paid_time: epoch("2026-11-07 02:01:00") });
    tiktok.addOrder({ id: "586000000000000002", status: "AWAITING_SHIPMENT", create_time: epoch("2026-11-08 02:00:00"), paid_time: epoch("2026-11-08 02:01:00") });
    tiktok.addOrder({ id: "586000000000000003", status: "UNPAID", create_time: epoch("2026-11-05 03:00:00") });
    tiktok.addOrder({ id: "586000000000000005", status: "AWAITING_SHIPMENT", create_time: epoch("2026-11-05 03:59:00"), paid_time: epoch("2026-11-05 04:00:00") });

    const r = await runFixup({ ...E, WEEKEND_TO_MONDAY: "1" });

    expect(r.errors).toEqual([]);
    expect(r.tiktok).toBe("connected");
    expect(r.tiktokDates).toEqual({
      dryRun: false,
      changed: [
        { order: "SO/1", ref: "586981877055325743", from: "2026-11-05 01:58:22", to: "2026-11-05 02:00:10" },
        { order: "SO/2", ref: "586954772163626642", from: "2026-11-03 19:51:45", to: "2026-11-03 19:51:45" },
        { order: "SO/3", ref: "586000000000000001", from: "2026-11-07 02:00:00", to: "2026-11-08 17:00:00" },
        { order: "SO/4", ref: "586000000000000002", from: "2026-11-08 02:00:00", to: "2026-11-08 17:01:00" },
      ].filter((c) => c.from !== c.to),
    });
    expect(odoo.get("sale.order", 3)!.date_order).toBe("2026-11-08 17:00:00"); // Senin 00:00 WIB
    expect(odoo.get("sale.order", 4)!.date_order).toBe("2026-11-08 17:01:00"); // Senin 00:01 WIB
    expect(odoo.get("sale.order", 5)!.date_order).toBe("2026-11-05 03:00:00");
    // Satu panggilan untuk semua pesanan aktif; SO batal tidak ditanyakan.
    expect(tiktok.calls).toHaveLength(1);
    expect(tiktok.calls[0]!.query.ids!.split(",")).not.toContain("586000000000000004");
    // Rahasia toko tidak pernah masuk laporan.
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(TOKEN);

    const writes = odoo.writes().length;
    const r2 = await runFixup({ ...E, WEEKEND_TO_MONDAY: "1" });
    expect(r2.tiktokDates.changed).toEqual([]);
    expect(odoo.writes().length).toBe(writes);
  });

  it("COD memakai waktu pesanan dibuat", async () => {
    order(2, "COD1", "2026-11-04 10:00:00");
    tiktok.addOrder({ id: "COD1", status: "AWAITING_SHIPMENT", create_time: epoch("2026-11-04 09:58:00"), is_cod: true });

    const r = await runFixup(E);

    expect(r.tiktokDates.changed).toEqual([{ order: "SO/2", ref: "COD1", from: "2026-11-04 10:00:00", to: "2026-11-04 09:58:00" }]);
  });

  it("dry run bila TIKTOK_DATE_WRITE bukan 1", async () => {
    order(1, "R1", "2026-11-04 10:00:00");
    tiktok.addOrder({ id: "R1", status: "AWAITING_SHIPMENT", create_time: epoch("2026-11-04 10:00:00"), paid_time: epoch("2026-11-04 11:00:00") });

    const r = await runFixup({ ...E, TIKTOK_DATE_WRITE: "0" });

    expect(r.tiktokDates.dryRun).toBe(true);
    expect(r.tiktokDates.changed).toHaveLength(1);
    expect(odoo.get("sale.order", 1)!.date_order).toBe("2026-11-04 10:00:00");
  });

  it("melewati toko yang kredensialnya kosong tanpa memanggil TikTok", async () => {
    odoo.get("tiktok.shop", 1)!.access_token = false;
    order(1, "R1", "2026-11-04 10:00:00");

    const r = await runFixup(E);

    expect(r.tiktok).toBe("not_configured");
    expect(tiktok.calls).toEqual([]);
  });

  it("melaporkan galat TikTok tanpa menghentikan langkah lain", async () => {
    tiktok.failWith = { code: 105002, message: "Expired credentials" };
    order(1, "R1", "2026-11-04 10:00:00");

    const r = await runFixup(E);

    expect(r.errors.map((e) => e.step)).toEqual(["tiktok_order_date"]);
    expect(r.errors[0]!.error).toContain("105002");
    expect(r.contactsRenamed).toHaveLength(1);
  });
});

describe("Tanggal Terjadwal pengiriman", () => {
  const picking = (id: number, sale: number, state: string, at: string) =>
    odoo.add("stock.picking", { id, name: `DO/${id}`, sale_id: sale, state, scheduled_date: at });

  it("mengikuti Tanggal Order hanya pada pengiriman yang belum selesai", async () => {
    order(1, "R1", "2026-11-07 02:00:00");
    tiktok.addOrder({ id: "R1", status: "AWAITING_SHIPMENT", create_time: epoch("2026-11-07 02:00:00"), paid_time: epoch("2026-11-07 02:01:00") });
    picking(11, 1, "assigned", "2026-11-07 02:00:00");
    picking(12, 1, "done", "2026-11-07 02:00:00");
    picking(13, 1, "cancel", "2026-11-07 02:00:00");

    const r = await runFixup({ ...E, WEEKEND_TO_MONDAY: "1" });

    expect(r.errors).toEqual([]);
    expect(r.scheduledDates).toEqual([{ picking: "DO/11", order: "SO/1", from: "2026-11-07 02:00:00", to: "2026-11-08 17:00:00" }]);
    expect(odoo.get("stock.picking", 11)!.scheduled_date).toBe("2026-11-08 17:00:00");
    expect(odoo.get("stock.picking", 12)!.scheduled_date).toBe("2026-11-07 02:00:00");
    expect(odoo.get("stock.picking", 13)!.scheduled_date).toBe("2026-11-07 02:00:00");

    const writes = odoo.writes().length;
    expect((await runFixup({ ...E, WEEKEND_TO_MONDAY: "1" })).scheduledDates).toEqual([]);
    expect(odoo.writes().length).toBe(writes);
  });

  it("dry run bila penulisan tanggal marketplace dimatikan", async () => {
    order(1, "R1", "2026-11-04 10:00:00");
    picking(11, 1, "assigned", "2026-11-04 09:00:00");

    const r = await runFixup({ ...E, TIKTOK_DATE_WRITE: "0" });

    expect(r.scheduledDates).toHaveLength(1);
    expect(odoo.get("stock.picking", 11)!.scheduled_date).toBe("2026-11-04 09:00:00");
  });

  it("membiarkan SO yang dibuat sebelum batas tanggal", async () => {
    order(1, "R1", "2026-11-04 10:00:00", { create_date: odooDatetime(new Date(Date.now() - 3600_000)) });
    picking(11, 1, "assigned", "2026-11-04 09:00:00");

    const r = await runFixup({ ...E, TIKTOK_DATE_FROM: odooDatetime(new Date(Date.now() - 60_000)) });

    expect(r.scheduledDates).toEqual([]);
  });
});

describe("nama kontak TikTok", () => {
  it("memberi nama T-<no pesanan> (<nama>) dan mengikuti pesanan terbaru pembeli", async () => {
    order(1, "586937938589943642", "2026-11-04 10:00:00");
    odoo.get("res.partner", 5001)!.name = "Budi Santoso";
    order(2, "586999999999999999", "2026-11-04 11:00:00", { partner_id: 5001 });
    // SO Shopee tetap berawalan S.
    odoo.add("shopee.shop", { id: 2, name: "Toko Shopee", shop_identifier: 225736119 });
    odoo.add("res.partner", { id: 6000, name: "miella.iklima" });
    odoo.add("sale.order", { id: 3, name: "SO/3", state: "sale", shopee_shop_id: 2, shopee_order_ref: "261029UKGR4Y2Y", partner_id: 6000, create_date: now() });

    const r = await runFixup(E);

    expect(r.errors).toEqual([]);
    expect(odoo.get("res.partner", 5001)!.name).toBe("T-586999999999999999 (Budi Santoso)");
    expect(odoo.get("res.partner", 6000)!.name).toBe("S-261029UKGR4Y2Y (miella.iklima)");

    const r2 = await runFixup(E);
    expect(r2.contactsRenamed).toEqual([]);
  });
});
