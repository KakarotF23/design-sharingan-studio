import { expect, it } from "vitest";
import * as adapters from "../index";
// Production break: a status-shaped capture can be mistaken for authenticated browser/rule evidence.
it("rejects governance capture claims with no exact render, runtime checks, or approved Genome identity", () => {
  expect(adapters).toHaveProperty("isGovernanceCaptureSession");
  expect(adapters.isGovernanceCaptureSession({ id: "capture-1", projectId: "p", type: "GOVERNANCE_CAPTURE", status: "COMPLETE", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), checks: { navigation: "PASS" } })).toBe(false);
});
