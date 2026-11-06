/**
 * Odoo tiruan untuk test: menjawab JSON-RPC `common.authenticate` dan
 * `object.execute_kw` (search_read, read, write, create, unlink, action_lock,
 * action_unlock) di atas data
 * di memori. Domain dievaluasi sungguhan, termasuk jalur bertitik lewat
 * many2one (`order_id.shopee_shop_id`), supaya domain yang dikirim Worker ikut
 * teruji, bukan hanya diloloskan.
 */
type Rec = Record<string, unknown> & { id: number };

/** many2one per model → model tujuan. */
const RELATIONS: Record<string, Record<string, string>> = {
  "sale.order": { partner_id: "res.partner", shopee_shop_id: "shopee.shop", tiktok_shop_id: "tiktok.shop" },
  "sale.order.line": {
    order_id: "sale.order",
    product_id: "product.product",
    linked_line_id: "sale.order.line",
    combo_item_id: "product.combo.item",
  },
  "product.product": { product_tmpl_id: "product.template" },
  "product.pricelist.item": { product_tmpl_id: "product.template" },
  "stock.picking": { sale_id: "sale.order" },
  "product.combo.item": { product_id: "product.product", combo_id: "product.combo" },
};

export type Call = { model: string; method: string; args: unknown[] };

export class FakeOdoo {
  tables: Record<string, Map<number, Rec>> = {};
  calls: Call[] = [];
  private nextId = 10_000;

  add(model: string, rec: Rec): Rec {
    (this.tables[model] ??= new Map()).set(rec.id, rec);
    return rec;
  }

  get(model: string, id: number): Rec | undefined {
    return this.tables[model]?.get(id);
  }

  all(model: string): Rec[] {
    return [...(this.tables[model]?.values() ?? [])];
  }

  writes(): Call[] {
    return this.calls.filter((c) => ["write", "create", "unlink"].includes(c.method));
  }

  /** Nilai field, termasuk field terhitung yang dipakai Worker. */
  private value(model: string, rec: Rec, field: string): unknown {
    if (model === "sale.order.line") {
      if (field === "state") return this.get("sale.order", rec.order_id as number)?.state;
      if (field === "product_template_id") {
        return this.get("product.product", rec.product_id as number)?.product_tmpl_id ?? false;
      }
      if (field === "linked_line_ids") {
        return this.all(model).filter((l) => l.linked_line_id === rec.id).map((l) => l.id);
      }
    }
    if (model === "product.combo" && field === "combo_item_ids") {
      return this.all("product.combo.item").filter((i) => i.combo_id === rec.id).map((i) => i.id);
    }
    return rec[field] ?? false;
  }

  private relation(model: string, field: string): string | undefined {
    if (model === "sale.order.line" && field === "product_template_id") return "product.template";
    return RELATIONS[model]?.[field];
  }

  private resolve(model: string, rec: Rec, path: string): unknown {
    const [head, ...rest] = path.split(".");
    const v = this.value(model, rec, head!);
    if (rest.length === 0) return v;
    const target = this.relation(model, head!);
    const next = target && typeof v === "number" ? this.get(target, v) : undefined;
    return next ? this.resolve(target!, next, rest.join(".")) : false;
  }

  private matches(model: string, rec: Rec, domain: unknown[]): boolean {
    return domain.every((leaf) => {
      const [path, op, expected] = leaf as [string, string, unknown];
      const v = this.resolve(model, rec, path);
      switch (op) {
        case "=":
          return v === expected;
        case "!=":
          return v !== expected;
        case "in":
          return (expected as unknown[]).includes(v);
        case ">":
          return (v as number | string) > (expected as number | string);
        case ">=":
          return (v as number | string) >= (expected as number | string);
        default:
          throw new Error(`operator domain belum didukung tiruan: ${op}`);
      }
    });
  }

  private present(model: string, rec: Rec, fields: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = { id: rec.id };
    for (const f of fields) {
      const v = this.value(model, rec, f);
      const target = this.relation(model, f);
      if (target && typeof v === "number") {
        const ref = this.get(target, v);
        out[f] = [v, (ref?.name as string) ?? `${target},${v}`];
      } else {
        out[f] = v;
      }
    }
    return out;
  }

  handle(service: string, method: string, args: unknown[]): unknown {
    if (service === "common" && method === "authenticate") {
      return args[3] !== undefined && args[2] === "test-key" ? 2 : false;
    }
    const [, , , model, op, opArgs, kwargs] = args as [
      string, number, string, string, string, unknown[], Record<string, unknown> | undefined,
    ];
    this.calls.push({ model, method: op, args: opArgs });
    const table = (this.tables[model] ??= new Map());
    switch (op) {
      case "search_read": {
        const fields = (kwargs?.fields as string[]) ?? [];
        const rows = [...table.values()].filter((r) => this.matches(model, r, opArgs[0] as unknown[]));
        if (kwargs?.order === "id asc") rows.sort((a, b) => a.id - b.id);
        return rows.map((r) => this.present(model, r, fields));
      }
      case "read": {
        const [ids, fields] = opArgs as [number[], string[]];
        return ids.map((id) => table.get(id)).filter(Boolean).map((r) => this.present(model, r!, fields));
      }
      case "write": {
        const [ids, vals] = opArgs as [number[], Record<string, unknown>];
        if (model === "sale.order.line") this.checkLocked(ids, vals);
        for (const id of ids) Object.assign(table.get(id)!, vals);
        return true;
      }
      case "action_lock":
      case "action_unlock": {
        for (const id of opArgs[0] as number[]) table.get(id)!.locked = op === "action_lock";
        return null;
      }
      case "create": {
        const [list] = opArgs as [Record<string, unknown>[]];
        return list.map((vals) => this.add(model, { ...vals, id: this.nextId++ }).id);
      }
      case "unlink": {
        for (const id of opArgs[0] as number[]) table.delete(id);
        return true;
      }
      default:
        throw new Error(`metode belum didukung tiruan: ${op}`);
    }
  }

  /** Seperti `sale.order.line.write` Odoo 19: field terlindung ditolak pada SO terkunci. */
  private checkLocked(ids: number[], vals: Record<string, unknown>) {
    const protectedFields = ["product_id", "name", "price_unit", "product_uom_id", "product_uom_qty", "tax_ids", "discount"];
    const locked = ids.some((id) => this.get("sale.order", this.get("sale.order.line", id)?.order_id as number)?.locked);
    if (locked && Object.keys(vals).some((f) => protectedFields.includes(f))) {
      throw new Error("It is forbidden to modify the following fields in a locked order");
    }
  }

  /** Pasang sebagai `fetch` global; panggilan ke host lain diteruskan. */
  install(host: string): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(host)) return original(input as RequestInfo, init);
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        params: { service: string; method: string; args: unknown[] };
      };
      try {
        const result = this.handle(body.params.service, body.params.method, body.params.args);
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      } catch (err) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { message: "Odoo Server Error", data: { name: "Error", message: String(err) } },
        });
      }
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }
}
