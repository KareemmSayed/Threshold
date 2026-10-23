import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          GARMIN_API_KEY: "test-garmin-key",
          ACCESS_KEY: "test-access-key-0123456789",
          GARMIN_API_BASE_URL: "https://garmin.mock",
          TIMEZONE: "Europe/Berlin",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
