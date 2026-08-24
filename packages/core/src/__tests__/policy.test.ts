import { describe, expect, it } from "vitest";
import { DEFAULT_AUTONOMY_POLICY, evaluateAutonomyPolicy } from "../policy";

describe("autonomy policy", () => {
  it("allows style-only edits", () => {
    expect(
      evaluateAutonomyPolicy(DEFAULT_AUTONOMY_POLICY, {
        kind: "STYLE_CHANGE",
        files: ["src/Home.tsx"]
      }).decision
    ).toBe("ALLOW");
  });

  it("escalates navigation changes", () => {
    expect(
      evaluateAutonomyPolicy(DEFAULT_AUTONOMY_POLICY, {
        kind: "NAVIGATION_CHANGE",
        files: ["src/navigation.ts"]
      }).decision
    ).toBe("HUMAN_GATE");
  });

  it("blocks protected paths", () => {
    const policy = {
      ...DEFAULT_AUTONOMY_POLICY,
      protectedPaths: ["src/auth/**"]
    };

    expect(
      evaluateAutonomyPolicy(policy, {
        kind: "STYLE_CHANGE",
        files: ["src/auth/Login.tsx"]
      }).decision
    ).toBe("HUMAN_GATE");
  });
});
