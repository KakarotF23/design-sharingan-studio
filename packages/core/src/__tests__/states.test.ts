import { describe, expect, it } from "vitest";
import {
  canTransitionProject,
  canTransitionLearnSession,
  canTransitionSafeExecution,
  canTransitionMangekyo
} from "../states";

describe("workflow state machines", () => {
  it("allows project scan to require configuration", () => {
    expect(canTransitionProject("SCANNING", "NEEDS_CONFIGURATION")).toBe(true);
  });

  it("prevents Safe Mode from editing before approval", () => {
    expect(canTransitionSafeExecution("WAITING_APPROVAL", "EDITING")).toBe(false);
    expect(canTransitionSafeExecution("APPROVED", "EDITING")).toBe(true);
  });

  it("routes an analysed learn session to an explicit human decision", () => {
    expect(canTransitionLearnSession("RESULT_READY", "AWAITING_DECISION")).toBe(true);
    expect(canTransitionLearnSession("AWAITING_DECISION", "APPROVED")).toBe(true);
    expect(canTransitionLearnSession("AWAITING_DECISION", "ANALYZING")).toBe(false);
  });

  it("routes Mangekyo policy escalation through HUMAN_GATE", () => {
    expect(canTransitionMangekyo("DECIDING", "HUMAN_GATE")).toBe(true);
    expect(canTransitionMangekyo("DECIDING", "EDITING")).toBe(false);
  });
});
