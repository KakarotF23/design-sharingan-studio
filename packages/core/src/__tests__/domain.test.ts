import { describe, it } from "vitest";
import type { DesignApproach, UXImpact } from "../domain";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Value extends true> = Value;

type DesignApproachUxImpactIsAnArray = Assert<
  Equal<DesignApproach["uxImpact"], UXImpact[]>
>;

describe("domain contracts", () => {
  it("models DesignApproach UX impact as an array", () => {
    void (0 as unknown as DesignApproachUxImpactIsAnArray);
  });
});
