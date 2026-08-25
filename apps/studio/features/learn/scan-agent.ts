import { CodexAgent } from "@design-sharingan/agent-runtime";
import type { ScanAgent, ScanWireOutput } from "@design-sharingan/sharingan-engine";

const fakeOutput: ScanWireOutput = {
  hierarchy: "Clear hierarchy leads from the primary subject into supporting evidence.",
  layout: "A restrained split frame separates visual evidence from interpretation.",
  spacing: "Large sectional intervals surround tightly grouped decisions.",
  typography: "Condensed display type contrasts with neutral, legible body copy.",
  colorLogic: "Near-black surfaces use bone text and one restrained crimson accent.",
  componentGeometry: "Square panels and fine rules communicate technical precision.",
  navigation: "A stable project rail keeps the analysis workflow oriented.",
  interaction: "Primary actions are explicit while secondary choices remain quiet.",
  motion: "Motion is reserved for analysis progress and result arrival.",
  density: "Dense evidence is balanced by a spacious decision summary.",
  emotionalTone: "Calm, technical, and deliberate rather than theatrical.",
  visualWeight: "The reference anchors the view while decisions form the counterweight.",
  keep: ["Clear hierarchy", "Deliberate contrast"],
  reject: ["Branded artwork", "Decorative controls"],
  adapt: ["Translate the accent into the product crimson token"],
  invent: ["Add an explicit product-fit decision trail"],
};

export function createScanAgent(): ScanAgent {
  if (process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1") {
    return {
      async run<TStructured>() {
        return {
          threadId: "fake-reference-scan-thread",
          finalResponse: JSON.stringify(fakeOutput),
          structured: fakeOutput as TStructured,
          items: [],
        };
      },
    };
  }
  return new CodexAgent();
}
