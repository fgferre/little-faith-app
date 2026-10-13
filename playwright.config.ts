import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    serviceWorkers: "allow",
  },
  webServer: [{
    command:
      // O build da suíte é sempre "sem servidor", mesmo com um .env real na máquina (piloto).
      "VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npm run build && npm run preview --workspace @bolao/web -- --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  }, {
    command: "node tests/e2e/serve-scoped.mjs",
    url: "http://127.0.0.1:4181",
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  }, {
    command: "node tests/e2e/serve-financial.mjs",
    url: "http://127.0.0.1:4190/__test/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  }, {
    command:
      "VITE_SUPABASE_URL=http://127.0.0.1:4190 VITE_SUPABASE_ANON_KEY=local-browser-test-public-key node tests/e2e/serve-configured.mjs",
    url: "http://127.0.0.1:4182",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  }, {
    command: "node tests/e2e/serve-updates.mjs",
    url: "http://127.0.0.1:4191",
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  }],
});
