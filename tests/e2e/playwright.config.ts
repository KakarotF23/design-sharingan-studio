import { defineConfig } from "@playwright/test";

const e2eStateRoot = "/private/tmp/design-sharingan-studio-e2e-state";
process.env.DESIGN_SHARINGAN_STATE_ROOT = e2eStateRoot;

export default defineConfig({
  testDir: ".",
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
    reuseExistingServer: !process.env.CI
  }
});
