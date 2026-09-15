import { describe, expect, it } from "vitest";
import config from "./playwright.config";

describe("Studio E2E server isolation", () => {
  // Production break caught: reusing an arbitrary listener on port 3000 can
  // silently run E2E against a live, authenticated Studio instead of its
  // test-owned fake-agent server.
  it("always owns a fake-agent server instead of reusing an existing listener", () => {
    const webServer = Array.isArray(config.webServer)
      ? config.webServer[0]
      : config.webServer;
    expect(webServer).toBeDefined();
    expect(webServer?.reuseExistingServer).toBe(false);
    expect(webServer?.env?.DESIGN_SHARINGAN_FAKE_AGENT).toBe("1");
  });

  it("excludes this Vitest configuration check from Playwright discovery", () => {
    expect(config.testIgnore).toContain("**/playwright-config.test.ts");
  });
});
