import { expect, it } from "vitest";
import { activityFor } from "./execute-workspace";

// Production break caught: the pending approval HTTP action hides durable rendering/completion/failure progress behind stale pre-mutation wording.
it.each([
  ["EDITING", "Approved mutation applied; render verification is next"],
  ["RUNNING", "Starting the project for fresh render verification"],
  ["CAPTURING", "Capturing the final approved source"],
  ["VERIFYING", "Verifying the fresh scoped render"],
  ["COMPLETE", "Fresh scoped render verified"],
  ["FAILED", "Render verification failed; applied files are preserved"],
] as const)("reports durable %s evidence while the action response is pending", (status, text) => {
  expect(activityFor({ status }, true, "APPROVE_PROPOSAL")).toBe(text);
  expect(activityFor({ status }, false, undefined)).toBe(text);
});
