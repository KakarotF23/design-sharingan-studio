import { describe, expect, it } from "vitest";
import * as engine from "../index";

describe("readonly design VERIFY", () => {
  // Production break: VERIFY has no callable readonly comparison, so the fourth V1 mode cannot run.
  it("compares intended logic and the supplied current direction without mutation authority", async () => {
    expect(engine).toHaveProperty("verifyDesignDirection");
    let request: Record<string, unknown> | undefined;
    const result = await engine.verifyDesignDirection({ intendedDirection: "Keep stable navigation", currentDirection: "A new route is proposed", analysisWorkingDirectory: "/isolated/analysis" }, { agent: { async run(input) { request = input as unknown as Record<string, unknown>; return { threadId: "verify-thread", structured: { summary: "Navigation needs a human decision", findings: [{ severity: "IMPORTANT", principle: "Stable navigation", observation: "A new route is proposed", recommendation: "Keep the existing route" }] } as never }; } } });
    expect(request).toMatchObject({ capabilityProfile: "ANALYSIS", workingDirectory: "/isolated/analysis" });
    expect(request?.prompt).toContain("A new route is proposed");
    expect(result).toMatchObject({ threadId: "verify-thread", evidenceScope: "DESIGN_DIRECTION_ONLY", findings: [{ severity: "IMPORTANT" }] });
  });
  // Production break: an agent may smuggle a visual PASS into a text-only VERIFY result.
  it("rejects invented authority and malformed severities", async () => {
    expect(engine).toHaveProperty("verifyDesignDirection");
    for (const output of [{ summary: "Good", findings: [], visualPass: true }, { summary: "Good", findings: [{ severity: "PASS", principle: "a", observation: "b", recommendation: "c" }] }]) {
      await expect(engine.verifyDesignDirection({ intendedDirection: "Keep navigation", currentDirection: "Navigation remains", analysisWorkingDirectory: "/isolated/analysis" }, { agent: { async run() { return { threadId: "t", structured: output as never }; } } })).rejects.toThrow(/invalid/);
    }
  });
});
