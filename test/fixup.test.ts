import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { odooDatetime } from "../src/core/rules";
import type { Env } from "../src/env";
import { runFixup } from "../src/jobs/fixup";
import { FakeOdoo } from "./fake-odoo";

const E = env as unknown as Env;

const FEE_DISCOUNT = 953;
const FEE_ADJUSTMENT = 652;
const COMBO_PRODUCT = 700;
const BT = [617, 618, 619, 620, 621];

let odoo: FakeOdoo;
let uninstall: () => void;

const now = () => odooDatetime(new Date());
const daysAgo = (d: number) => odooDatetime(new Date(Date.now() - d * 86400_000));

/** Katalog: CB-BT1-5 (combo BT1–BT5, Harga Combo 12.000 per grup). */
function seedCatalog() {
  odoo.add("product.template", { id: 692, name: "Bundling Buku Tilawah 1-5", type: "combo", combo_ids: [81, 82, 83, 84, 85] });
  odoo.add("product.product", { id: COMBO_PRODUCT, name: "[CB-BT1-5] Bundling Buku Tilawah 1-5", type: "combo", product_tmpl_id: 692 });
  BT.forEach((pid, i) => {
    odoo.add("product.product", { id: pid, name: `[BT${i + 1}] Buku Tilawah Wafa ${i + 1}`, type: "consu", product_tmpl_id: pid });
    odoo.add("product.combo", { id: 81 + i, name: `BT${i + 1}`, base_price: 12000 });
    odoo.add("product.combo.item", { id: 85 + i, combo_id: 81 + i, product_id: pid });
  });
  odoo.add("shopee.shop", { id: 2, name: "Toko Shopee #225736119", shop_identifier: 225736119 });
  odoo.add("product.product", { id: FEE_DISCOUNT, name: "Shopee Order Discount", type: "service" });
  odoo.add("product.product", { id: FEE_ADJUSTMENT, name: "Shopee Amount Adjustment", type: "service" });
}

function order(id: number, o: Partial<Record<string, unknown>> = {}) {
  return odoo.add("sale.order", {
    id,
    name: `SO/${id}`,
    state: "sale",
    locked: false,
    shopee_shop_id: 2,
    shopee_order_ref: `REF${id}`,
    partner_id: 5000 + id,
    create_date: now(),
    ...o,
  });
}

function line(id: number, orderId: number, productId: number, price: number, o: Partial<Record<string, unknown>> = {}) {
  return odoo.add("sale.order.line", {
    id,
    order_id: orderId,
    product_id: productId,
    price_unit: price,
    product_uom_qty: 1,
    qty_invoiced: 0,
    sequence: 10,
    ...o,
  });
}

beforeEach(() => {
  odoo = new FakeOdoo();
  uninstall = odoo.install("https://odoo.test");
  seedCatalog();
});

afterEach(() => uninstall());

describe("runFixup", () => {
  it("merapikan SO bundling Shopee seperti SO 6597", async () => {
    order(6597, { shopee_order_ref: "261029V1SK2G1A" });
    odoo.add("res.partner", { id: 11597, name: "nabilaimaniy" });
    odoo.get("sale.order", 6597)!.partner_id = 11597;
    line(1, 6597, COMBO_PRODUCT, 130000);
    line(2, 6597, FEE_DISCOUNT, -6500);
    line(3, 6597, FEE_ADJUSTMENT, 2000);

    const r = await runFixup(E);

    expect(r.errors).toEqual([]);
    expect(r.feeLinesZeroed.sort()).toEqual([2, 3]);
    expect(odoo.get("sale.order.line", 2)!.price_unit).toBe(0);
    expect(odoo.get("sale.order.line", 3)!.price_unit).toBe(0);

    // Combo: harga pindah ke 5 sub-baris yang tertaut, baris combo jadi 0.
    expect(odoo.get("sale.order.line", 1)!.price_unit).toBe(0);
    const children = odoo.all("sale.order.line").filter((l) => l.linked_line_id === 1);
    expect(children.map((c) => [c.product_id, c.price_unit, c.combo_item_id, c.product_uom_qty])).toEqual(
      BT.map((pid, i) => [pid, 26000, 85 + i, 1]),
    );
    expect(children.every((c) => c.order_id === 6597)).toBe(true);

    expect(odoo.get("res.partner", 11597)!.name).toBe("S-261029V1SK2G1A (nabilaimaniy)");
    expect(r.rpcCalls).toBeLessThan(50);
  });

  it("aman diulang: putaran kedua tidak menulis apa pun", async () => {
    order(1);
    odoo.add("res.partner", { id: 5001, name: "pembeli" });
    line(1, 1, COMBO_PRODUCT, 130000, { product_uom_qty: 2 });
    line(2, 1, FEE_DISCOUNT, -1000);

    await runFixup(E);
    const before = odoo.writes().length;
    const r2 = await runFixup(E);

    expect(odoo.writes().length).toBe(before);
    expect(r2.combosSplit).toEqual([]);
    expect(r2.contactsRenamed).toEqual([]);
    // Qty combo ikut ke sub-baris.
    expect(odoo.all("sale.order.line").filter((l) => l.linked_line_id === 1).every((c) => c.product_uom_qty === 2)).toBe(true);
  });

  it("merapikan SO yang dibuat terkunci seperti SO 6605, lalu menguncinya lagi", async () => {
    order(6605, { locked: true });
    order(6606);
    line(1, 6605, FEE_DISCOUNT, -4275);
    line(2, 6605, COMBO_PRODUCT, 130000);
    line(3, 6606, FEE_ADJUSTMENT, 1400);

    const r = await runFixup(E);

    expect(r.errors).toEqual([]);
    expect(odoo.get("sale.order.line", 1)!.price_unit).toBe(0);
    expect(odoo.get("sale.order.line", 2)!.price_unit).toBe(0);
    expect(odoo.all("sale.order.line").filter((l) => l.linked_line_id === 2)).toHaveLength(5);
    expect(odoo.get("sale.order", 6605)!.locked).toBe(true);
    // SO yang semula tidak terkunci tidak ikut dikunci.
    expect(odoo.get("sale.order", 6606)!.locked).toBe(false);
  });

  it("mengunci lagi SO walaupun penulisan gagal", async () => {
    order(1, { locked: true });
    line(1, 1, FEE_DISCOUNT, -1000);
    const write = odoo.handle.bind(odoo);
    odoo.handle = (service, method, args) => {
      if ((args as unknown[])[4] === "write") throw new Error("gagal");
      return write(service, method, args);
    };

    const r = await runFixup(E);

    expect(r.errors.map((e) => e.step)).toContain("fee_lines");
    expect(odoo.get("sale.order", 1)!.locked).toBe(true);
  });

  it("melewati SO batal, sudah difakturkan, di luar rentang, dan bukan Shopee", async () => {
    order(1, { state: "cancel" });
    order(2, { locked: true });
    order(3);
    order(4, { create_date: daysAgo(5) });
    order(5, { shopee_shop_id: false });
    line(1, 1, FEE_DISCOUNT, -1000);
    line(2, 2, COMBO_PRODUCT, 130000, { qty_invoiced: 1 });
    line(3, 3, FEE_DISCOUNT, -1000, { qty_invoiced: 1 });
    line(4, 4, COMBO_PRODUCT, 130000);
    line(5, 5, COMBO_PRODUCT, 130000);

    const r = await runFixup(E);

    expect(r.feeLinesZeroed).toEqual([]);
    expect(r.combosSplit).toEqual([]);
    expect(odoo.writes().filter((c) => c.model === "sale.order.line")).toEqual([]);
  });

  it("menghapus baris biaya pada SO draf, bukan mengenolkannya", async () => {
    order(1, { state: "draft" });
    line(1, 1, FEE_DISCOUNT, -1000);

    const r = await runFixup(E);

    expect(r.feeLinesDeleted).toEqual([1]);
    expect(odoo.get("sale.order.line", 1)).toBeUndefined();
  });

  it("hanya mengenolkan harga combo yang sub-barisnya sudah ada", async () => {
    order(1);
    line(1, 1, COMBO_PRODUCT, 130000);
    line(2, 1, BT[0]!, 26000, { linked_line_id: 1, combo_item_id: 85 });

    const r = await runFixup(E);

    expect(r.combosSplit).toEqual([]);
    expect(r.combosRepriced).toEqual([1]);
    expect(odoo.get("sale.order.line", 1)!.price_unit).toBe(0);
    expect(odoo.all("sale.order.line").filter((l) => l.linked_line_id === 1)).toHaveLength(1);
  });

  it("membiarkan combo manual (sudah dipecah, harga 0) dan baris combo qty 0", async () => {
    order(1);
    line(1, 1, COMBO_PRODUCT, 0);
    line(2, 1, COMBO_PRODUCT, 130000, { product_uom_qty: 0 });

    const r = await runFixup(E);

    expect(r.combosSplit).toEqual([]);
    expect(r.combosRepriced).toEqual([]);
  });

  it("memberi nama kontak pembeli yang memesan lagi dari pesanan terbarunya, sekali saja", async () => {
    odoo.add("res.partner", { id: 900, name: "S-OLDREF (miella.iklima)" });
    order(1, { partner_id: 900, shopee_order_ref: "261101AAA" });
    order(2, { partner_id: 900, shopee_order_ref: "261102BBB" });

    const r = await runFixup(E);
    expect(r.contactsRenamed).toEqual([{ partnerId: 900, from: "S-OLDREF (miella.iklima)", to: "S-261102BBB (miella.iklima)" }]);

    const r2 = await runFixup(E);
    expect(r2.contactsRenamed).toEqual([]);
  });

  it("dry run melaporkan rencana tanpa menulis", async () => {
    order(1);
    odoo.add("res.partner", { id: 5001, name: "pembeli" });
    line(1, 1, COMBO_PRODUCT, 130000);
    line(2, 1, FEE_DISCOUNT, -1000);

    const r = await runFixup(E, { dryRun: true });

    expect(r.dryRun).toBe(true);
    expect(r.feeLinesZeroed).toEqual([2]);
    expect(r.combosSplit[0]?.children.map((c) => c.price)).toEqual([26000, 26000, 26000, 26000, 26000]);
    expect(r.contactsRenamed).toHaveLength(1);
    expect(odoo.writes()).toEqual([]);
  });

  it("melaporkan kredensial yang ditolak tanpa melempar", async () => {
    const r = await runFixup({ ...E, ODOO_API_KEY: "salah" });
    expect(r.errors[0]?.step).toBe("authenticate");
  });
});

describe("endpoint", () => {
  it("menolak /admin tanpa kunci", async () => {
    const res = await SELF.fetch("https://worker.test/admin/run", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("menjalankan dry run lewat /admin/run?dry=1", async () => {
    order(1);
    line(1, 1, FEE_DISCOUNT, -1000);
    const res = await SELF.fetch("https://worker.test/admin/run?dry=1", {
      method: "POST",
      headers: { "x-admin-key": "test-admin" },
    });
    const body = (await res.json()) as { data: { dryRun: boolean; feeLinesZeroed: number[] } };
    expect(body.data.dryRun).toBe(true);
    expect(body.data.feeLinesZeroed).toEqual([1]);
    expect(odoo.writes()).toEqual([]);
  });
});
