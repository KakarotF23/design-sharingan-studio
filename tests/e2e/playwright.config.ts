import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  use: {
    baseURL: "http://127.0.0.1:3000"
  },
  webServer: {
    command: "pnpm --filter studio dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI
  }
});
