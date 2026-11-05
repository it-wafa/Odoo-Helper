import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ODOO_URL: "https://odoo.test",
          ODOO_DB: "test-db",
          ODOO_LOGIN: "bot@test",
          ODOO_API_KEY: "test-key",
          ADMIN_API_KEY: "test-admin",
          WRITE_ENABLED: "1",
          // Menimpa nilai dari .dev.vars supaya test tidak memakai kredensial asli.
          SHOPEE_HOST: "https://shopee.test",
          SHOPEE_SHOP_ID: "225736119",
          SHOPEE_PARTNER_ID: "2052005",
          SHOPEE_PARTNER_KEY: "test-partner-key",
          SHOPEE_DATE_WRITE: "1",
          TIKTOK_HOST: "https://tiktok.test",
          TIKTOK_DATE_WRITE: "1",
        },
        kvNamespaces: ["SHOPEE_KV"],
      },
    }),
  ],
});
