import { describe, expect, it } from "vitest";
import { normalizeGovernanceRoute } from "../governance-route";

describe("governance route canonicalization", () => {
  // Production break caught: validating only the raw bytes lets a second URL decode reveal traversal or reserved separators downstream.
  it.each([
    "/%252e%252e/private",
    "/a%252Fb",
    "/a%255Cb",
    "/a%253Fb",
    "/a%2523b",
  ])("rejects recursively encoded ambiguous route %s", (route) => {
    expect(() => normalizeGovernanceRoute(route)).toThrow(/route|encoded|encoding/i);
  });

  it("rejects percent encoding that remains beyond the bounded decode budget", () => {
    expect(() => normalizeGovernanceRoute(
      "/%252525252525252e%252525252525252e/private",
    )).toThrow(/route|encoded|encoding/i);
  });

  it.each([
    ["/caf%C3%A9", "/caf%C3%A9"],
    ["/cafe%CC%81", "/caf%C3%A9"],
    ["/over%76iew", "/overview"],
    ["/sale%25off", "/sale%25off"],
  ])("preserves valid canonical route %s as %s", (route, expected) => {
    expect(normalizeGovernanceRoute(route)).toBe(expected);
  });
});
