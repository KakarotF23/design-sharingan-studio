import type {
  CodexAgentResult,
  CodexAgentRunInput,
} from "@design-sharingan/agent-runtime";
import type { DesignDNA, Reference } from "@design-sharingan/core";
import { buildScanPrompt } from "./prompts";
import {
  SCAN_OUTPUT_SCHEMA,
  type ScanWireOutput,
} from "./schemas";

export type { ScanWireOutput } from "./schemas";

export interface ScanProjectContext {
  name: string;
  framework?: string;
  routes: readonly string[];
  componentDirectories: readonly string[];
  designDocuments: readonly string[];
}

export interface ScanReferenceInput {
  reference: Reference;
  stagedImagePath: string;
  analysisWorkingDirectory: string;
  projectContext: ScanProjectContext;
  notes?: string;
  analyzeForMe: boolean;
}

export interface ScanAgent {
  run<TStructured = unknown>(
    input: CodexAgentRunInput,
  ): Promise<CodexAgentResult<TStructured>>;
}

export interface ScanDependencies {
  agent: ScanAgent;
  createId(): string;
  persist(designDNA: DesignDNA): Promise<void>;
}

export interface ScanReferenceResult {
  designDNA: DesignDNA;
  threadId: string;
}

export async function scanReference(
  input: ScanReferenceInput,
  dependencies: ScanDependencies,
): Promise<ScanReferenceResult> {
  const result = await dependencies.agent.run<ScanWireOutput>({
    workingDirectory: input.analysisWorkingDirectory,
    prompt: buildScanPrompt(input),
    images: [input.stagedImagePath],
    outputSchema: SCAN_OUTPUT_SCHEMA,
  });
  const output = assertScanWireOutput(result.structured);
  const designDNA: DesignDNA = {
    id: dependencies.createId(),
    referenceIds: [input.reference.id],
    hierarchy: [output.hierarchy],
    layout: [output.layout],
    spacing: [output.spacing],
    typography: [output.typography],
    colorLogic: [output.colorLogic],
    componentGeometry: [output.componentGeometry],
    navigation: [output.navigation],
    interaction: [output.interaction],
    motion: [output.motion],
    density: [output.density],
    emotionalTone: [output.emotionalTone],
    visualWeight: [output.visualWeight],
    keep: [...output.keep],
    reject: [...output.reject],
    adapt: [...output.adapt],
    invent: [...output.invent],
  };

  await dependencies.persist(designDNA);
  return { designDNA, threadId: result.threadId };
}

function assertScanWireOutput(value: unknown): ScanWireOutput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex SCAN did not return structured output");
  }
  const output = value as Record<string, unknown>;
  const scalarFields = [
    "hierarchy",
    "layout",
    "spacing",
    "typography",
    "colorLogic",
    "componentGeometry",
    "navigation",
    "interaction",
    "motion",
    "density",
    "emotionalTone",
    "visualWeight",
  ] as const;
  const decisionFields = ["keep", "reject", "adapt", "invent"] as const;

  if (
    scalarFields.some((field) => typeof output[field] !== "string") ||
    decisionFields.some(
      (field) =>
        !Array.isArray(output[field]) ||
        !(output[field] as unknown[]).every((entry) => typeof entry === "string"),
    )
  ) {
    throw new Error("Codex SCAN returned invalid structured output");
  }
  return output as unknown as ScanWireOutput;
}
