import type { CodexAgentRunInput } from "@design-sharingan/agent-runtime";
import type { DesignDNA } from "@design-sharingan/core";
import { buildAssimilatePrompt } from "./prompts";
import {
  ASSIMILATE_OUTPUT_SCHEMA,
  type AssimilateWireOutput,
  type ScanWireOutput,
} from "./schemas";

export type { AssimilateWireOutput } from "./schemas";

export interface AssimilateProjectContext {
  name: string;
  routes: readonly string[];
}

export interface AssimilationSource {
  referenceIds: string[];
  role: string;
  principles: string[];
}

export interface AssimilateResult {
  summary: string;
  sourceMap: AssimilationSource[];
  proposedDirection: DesignDNA;
  threadId: string;
}

export interface AssimilateAgent {
  run<TStructured = unknown>(input: CodexAgentRunInput): Promise<{
    threadId: string;
    structured: TStructured | null;
  }>;
}

export async function assimilateReferences(
  input: {
    analyses: readonly DesignDNA[];
    analysisWorkingDirectory: string;
    projectContext: AssimilateProjectContext;
    learningIntent?: string;
  },
  dependencies: { agent: AssimilateAgent; createId(): string },
): Promise<AssimilateResult> {
  if (input.analyses.length < 2) {
    throw new Error("ASSIMILATE requires at least two reference analyses");
  }
  const referenceIds = [
    ...new Set(input.analyses.flatMap((analysis) => analysis.referenceIds)),
  ];
  if (referenceIds.length < 2) {
    throw new Error("ASSIMILATE requires at least two distinct references");
  }
  const result = await dependencies.agent.run<AssimilateWireOutput>({
    workingDirectory: input.analysisWorkingDirectory,
    prompt: buildAssimilatePrompt(input),
    outputSchema: ASSIMILATE_OUTPUT_SCHEMA,
  });
  const output = assertAssimilateWireOutput(result.structured, referenceIds);
  const direction = output.direction;
  return {
    summary: output.summary,
    sourceMap: output.sourceMap.map((source) => ({
      referenceIds: [...source.referenceIds],
      role: source.role,
      principles: [...source.principles],
    })),
    proposedDirection: {
      id: dependencies.createId(),
      referenceIds,
      hierarchy: [direction.hierarchy],
      layout: [direction.layout],
      spacing: [direction.spacing],
      typography: [direction.typography],
      colorLogic: [direction.colorLogic],
      componentGeometry: [direction.componentGeometry],
      navigation: [direction.navigation],
      interaction: [direction.interaction],
      motion: [direction.motion],
      density: [direction.density],
      emotionalTone: [direction.emotionalTone],
      visualWeight: [direction.visualWeight],
      keep: [...direction.keep],
      reject: [...direction.reject],
      adapt: [...direction.adapt],
      invent: [...direction.invent],
    },
    threadId: result.threadId,
  };
}

const DIRECTION_KEYS = [
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
  "keep",
  "reject",
  "adapt",
  "invent",
] as const;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function boundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function boundedStrings(
  value: unknown,
  options: { maxItems: number; maxItemLength: number },
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= options.maxItems &&
    value.every((entry) => boundedString(entry, options.maxItemLength))
  );
}

function isDirection(value: unknown): value is ScanWireOutput {
  if (!exactRecord(value, DIRECTION_KEYS)) return false;
  return (
    DIRECTION_KEYS.slice(0, 12).every((key) =>
      boundedString(value[key], 2_000),
    ) &&
    DIRECTION_KEYS.slice(12).every((key) =>
      boundedStrings(value[key], { maxItems: 12, maxItemLength: 1_000 }),
    )
  );
}

function assertAssimilateWireOutput(
  value: unknown,
  expectedReferenceIds: readonly string[],
): AssimilateWireOutput {
  if (!exactRecord(value, ["summary", "sourceMap", "direction"])) {
    throw new Error("Codex ASSIMILATE returned invalid structured output");
  }
  if (
    !boundedString(value.summary, 4_000) ||
    !Array.isArray(value.sourceMap) ||
    value.sourceMap.length < 2 ||
    value.sourceMap.length > 16 ||
    !value.sourceMap.every(
      (source) =>
        exactRecord(source, ["referenceIds", "role", "principles"]) &&
        boundedStrings(source.referenceIds, {
          maxItems: 32,
          maxItemLength: 128,
        }) &&
        boundedString(source.role, 256) &&
        boundedStrings(source.principles, {
          maxItems: 12,
          maxItemLength: 1_000,
        }),
    ) ||
    !isDirection(value.direction)
  ) {
    throw new Error("Codex ASSIMILATE returned invalid structured output");
  }
  const mappedIds = new Set(
    (value.sourceMap as AssimilationSource[]).flatMap((source) => source.referenceIds),
  );
  if (
    mappedIds.size !== expectedReferenceIds.length ||
    expectedReferenceIds.some((referenceId) => !mappedIds.has(referenceId))
  ) {
    throw new Error("Codex ASSIMILATE source map does not match the references");
  }
  return value as unknown as AssimilateWireOutput;
}
