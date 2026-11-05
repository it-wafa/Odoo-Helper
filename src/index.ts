import { Hono } from "hono";

import { boolVar, numberVar, type AppBindings, type Env } from "./env";
import { hasActivity, runFixup, shopeeClient } from "./jobs/fixup";

const app = new Hono<AppBindings>();

app.get("/health", (c) =>
  c.json({
    success: true,
    version: c.env.VERSION || "dev",
    odoo_url: c.env.ODOO_URL,
    odoo_db: c.env.ODOO_DB || null,
    write_enabled: boolVar(c.env.WRITE_ENABLED),
    lookback_hours: numberVar(c.env.LOOKBACK_HOURS, 48),
  }),
);

/**
 * Otorisasi toko Shopee: buka di browser, login sebagai penjual, setujui.
 * Shopee kembali ke `/shopee/callback`. Tanpa kunci admin karena hanya bisa
 * diselesaikan oleh penjual toko SHOPEE_SHOP_ID; toko lain ditolak di callback.
 */
app.get("/shopee/auth", async (c) => {
  const shopee = shopeeClient(c.env);
  if (!shopee) return c.text("Kredensial Shopee belum diisi.", 503);
  const redirect = new URL("/shopee/callback", c.req.url).href;
  return c.redirect(await shopee.authLink(redirect), 302);
});

app.get("/shopee/callback", async (c) => {
  const shopee = shopeeClient(c.env);
  if (!shopee) return c.text("Kredensial Shopee belum diisi.", 503);
  const code = c.req.query("code");
  const shopId = c.req.query("shop_id");
  if (!code || shopId !== c.env.SHOPEE_SHOP_ID) {
    return c.text(`Ditolak: hanya toko ${c.env.SHOPEE_SHOP_ID} yang boleh dihubungkan.`, 400);
  }
  try {
    const token = await shopee.exchangeCode(code);
    console.log(JSON.stringify({ at: "shopee_auth", shopId: token.shopId }));
    return c.text(`Toko ${token.shopId} terhubung. Halaman ini boleh ditutup.`);
  } catch (err) {
    console.error(JSON.stringify({ at: "shopee_auth", error: String(err) }));
    return c.text(`Gagal menukar kode otorisasi: ${String(err)}`, 502);
  }
});

/** Semua endpoint admin butuh header `x-admin-key`. */
app.use("/admin/*", async (c, next) => {
  const key = c.req.header("x-admin-key");
  if (!c.env.ADMIN_API_KEY || key !== c.env.ADMIN_API_KEY) {
    return c.json({ success: false, message: "Unauthorized" }, 401);
  }
  await next();
});

/**
 * Jalankan perbaikan di luar jadwal cron. `?dry=1` hanya melaporkan rencana
 * perubahan, berapa pun nilai WRITE_ENABLED.
 */
app.post("/admin/run", async (c) => {
  const dry = c.req.query("dry");
  const report = await runFixup(c.env, dry === undefined ? {} : { dryRun: boolVar(dry) });
  return c.json({ success: report.errors.length === 0, data: report });
});

/** Keadaan token Shopee, tanpa tokennya. */
app.get("/admin/shopee", async (c) => {
  const token = await shopeeClient(c.env)?.loadToken();
  return c.json({
    success: true,
    data: token
      ? {
          authorized: true,
          shop_id: token.shopId,
          access_token_expires_at: new Date(token.expiresAt).toISOString(),
          refreshed_at: new Date(token.refreshedAt).toISOString(),
        }
      : { authorized: false },
  });
});

app.notFound((c) => c.json({ success: false, message: "Not found" }, 404));
app.onError((err, c) => {
  console.error(JSON.stringify({ at: "unhandled", error: String(err) }));
  return c.json({ success: false, message: "Internal error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runFixup(env).then((r) => {
        if (r.errors.length > 0) console.error(JSON.stringify({ at: "fixup", ...r }));
        else if (hasActivity(r)) console.log(JSON.stringify({ at: "fixup", ...r }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
