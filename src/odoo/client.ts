export class OdooError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "OdooError";
  }
}

type ClientOptions = {
  url: string;
  db: string;
  login: string;
  apiKey: string;
  /** Batas waktu per panggilan. */
  timeoutMs?: number;
};

export type Domain = unknown[];
export type Row = Record<string, unknown>;

/**
 * Klien tipis JSON-RPC ke External API Odoo (POST {url}/jsonrpc), sama seperti
 * klien Go di SIFA (`server/internal/odoo/client.go`).
 *
 * Odoo Online tidak menerima modul kustom, dan kode Python di automation rule
 * ditagih sebagai "Maintenance Kode Kustom". Kode yang memanggil External API
 * dari luar tidak dihitung, jadi seluruh logika ada di Worker ini.
 */
export class OdooClient {
  private uid = 0;
  private seq = 0;
  /** Jumlah panggilan HTTP; paket gratis Workers membatasi 50 per invocation. */
  calls = 0;

  constructor(private readonly opts: ClientOptions) {}

  private async call<T>(service: string, method: string, args: unknown[]): Promise<T> {
    this.calls++;
    const res = await fetch(`${this.opts.url.replace(/\/+$/, "")}/jsonrpc`, {
      method: "POST",
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: ++this.seq,
        params: { service, method, args },
      }),
    });

    // Odoo memulangkan galat aplikasi dengan HTTP 200 dan field `error`;
    // status lain berarti lapisan di depannya (proxy, maintenance) yang bicara.
    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 300);
      throw new OdooError(`HTTP ${res.status}: ${snippet}`, res.status);
    }
    const body = (await res.json()) as {
      result?: T;
      error?: { message?: string; data?: { name?: string; message?: string } };
    };
    if (body.error) {
      const e = body.error;
      throw new OdooError(e.data?.message ? `${e.data.message} (${e.data.name})` : (e.message ?? "galat Odoo"));
    }
    return body.result as T;
  }

  /** Odoo memulangkan `false`, bukan galat, bila kredensial salah. */
  async authenticate(): Promise<void> {
    const uid = await this.call<number | false>("common", "authenticate", [
      this.opts.db,
      this.opts.login,
      this.opts.apiKey,
      {},
    ]);
    if (!uid) throw new OdooError("autentikasi ditolak: periksa ODOO_DB, ODOO_LOGIN, ODOO_API_KEY");
    this.uid = uid;
  }

  private executeKw<T>(model: string, method: string, args: unknown[], kwargs?: Row): Promise<T> {
    if (!this.uid) throw new OdooError(`${model}.${method} dipanggil sebelum authenticate`);
    const params: unknown[] = [this.opts.db, this.uid, this.opts.apiKey, model, method, args];
    if (kwargs) params.push(kwargs);
    return this.call<T>("object", "execute_kw", params);
  }

  searchRead(
    model: string,
    domain: Domain,
    fields: string[],
    opts: { limit?: number; order?: string } = {},
  ): Promise<Row[]> {
    return this.executeKw<Row[]>(model, "search_read", [domain], {
      fields,
      limit: opts.limit ?? 200,
      ...(opts.order ? { order: opts.order } : {}),
    });
  }

  /** Urutan hasil mengikuti urutan `ids`. */
  read(model: string, ids: number[], fields: string[]): Promise<Row[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.executeKw<Row[]>(model, "read", [ids, fields]);
  }

  async write(model: string, ids: number[], vals: Row): Promise<void> {
    if (ids.length === 0) return;
    await this.executeKw(model, "write", [ids, vals]);
  }

  /** Banyak record sekaligus; id dipulangkan dalam urutan yang sama dengan `vals`. */
  async create(model: string, vals: Row[]): Promise<number[]> {
    if (vals.length === 0) return [];
    const res = await this.executeKw<number | number[]>(model, "create", [vals]);
    return Array.isArray(res) ? res : [res];
  }

  async unlink(model: string, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.executeKw(model, "unlink", [ids]);
  }

  /** Metode publik model, mis. `sale.order.action_unlock`. */
  async action(model: string, method: string, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.executeKw(model, method, [ids]);
  }
}

/** many2one Odoo: `[id, "nama"]` atau `false`. */
export function m2oId(v: unknown): number | undefined {
  return Array.isArray(v) && typeof v[0] === "number" ? v[0] : undefined;
}

/** one2many/many2many Odoo: `[3, 7]` atau `false`. */
export function idList(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
}
