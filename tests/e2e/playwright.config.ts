import { defineConfig } from "@playwright/test";

const e2eStateRoot = "/private/tmp/design-sharingan-studio-e2e-state";
process.env.DESIGN_SHARINGAN_STATE_ROOT = e2eStateRoot;

export default defineConfig({
  testDir: ".",
  // This static Vitest check shares the E2E directory so it can import this
  // config, but Playwright must not try to execute it as a browser test.
  testIgnore: "**/playwright-config.test.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3000"
  },
  webServer: {
    command: "pnpm --filter studio dev",
    env: {
      ...process.env,
      DESIGN_SHARINGAN_IMPORT_ROOT:
        "/private/tmp/design-sharingan-studio-e2e-imports",
      DESIGN_SHARINGAN_FAKE_AGENT: "1",
      DESIGN_SHARINGAN_STATE_ROOT: e2eStateRoot,
    },
    url: "http://127.0.0.1:3000",
    // E2E must never attach to a developer's authenticated Studio at port
    // 3000. It owns a fresh server carrying this config's fake-agent marker.
    reuseExistingServer: false
  }
});
