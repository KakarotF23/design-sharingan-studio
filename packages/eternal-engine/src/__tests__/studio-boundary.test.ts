import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import * as eternal from "../index";
// Production break: Studio owns and can diverge from the governance authentication and release policy implementation.
it("owns governance policy and report authentication in Eternal rather than the Studio adapter", async () => {
  expect(eternal).toHaveProperty("authenticateGovernanceReportSession");
  expect(eternal).toHaveProperty("auditProjectDrift");
  const adapter = await readFile(resolve(import.meta.dirname, "../../../../apps/studio/features/govern/govern-server.ts"), "utf8");
  expect(adapter).not.toContain("function evaluateProjectReleaseGate");
  expect(adapter).not.toContain("function governanceSessionId");
});
