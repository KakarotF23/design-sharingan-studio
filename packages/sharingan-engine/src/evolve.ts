import type { CodexAgentRunInput } from "@design-sharingan/agent-runtime";
import type {
  DesignApproach,
  DesignDNA,
  DesignGenome,
  FeatureBrief,
  UXImpact,
} from "@design-sharingan/core";
import { buildEvolvePrompt } from "./prompts";
import {
  EVOLVE_OUTPUT_SCHEMA,
  type DesignApproachWireOutput,
  type EvolveStructuredOutput,
  type UXImpactWireOutput,
} from "./schemas";

export interface EvolveProjectContext {
  name: string;
  framework?: string;
  routes: readonly string[];
  componentDirectories: readonly string[];
  designDocuments: readonly string[];
}

export interface EvolveFeatureInput {
  featureBrief: FeatureBrief;
  referenceAnalyses: readonly DesignDNA[];
  analysisWorkingDirectory: string;
  projectContext: EvolveProjectContext;
  approvedGenome?: DesignGenome;
}

export type EvolveWireOutput = EvolveStructuredOutput;

export interface EvolveAgent {
  run<TStructured = unknown>(input: CodexAgentRunInput): Promise<{
    threadId: string;
    structured: TStructured | null;
  }>;
}

export interface EvolveResult extends EvolveWireOutput {
  threadId: string;
}

export async function evolveFeature(
  input: EvolveFeatureInput,
  dependencies: { agent: EvolveAgent },
): Promise<EvolveResult> {
  if (input.approvedGenome !== undefined && input.approvedGenome.status !== "APPROVED") {
    throw new Error("EVOLVE accepts only an approved Design Genome");
  }
  const result = await dependencies.agent.run<EvolveWireOutput>({
    workingDirectory: input.analysisWorkingDirectory,
    prompt: buildEvolvePrompt(input),
    outputSchema: EVOLVE_OUTPUT_SCHEMA,
  });
  const output = assertEvolveWireOutput(result.structured);
  return {
    uxImpact: output.uxImpact.map(copyImpact),
    approaches: output.approaches.map((approach) => ({
      ...approach,
      pros: [...approach.pros],
      cons: [...approach.cons],
      uxImpact: approach.uxImpact.map(copyImpact),
      likelyFiles: [...approach.likelyFiles],
    })),
    threadId: result.threadId,
  };
}

const UX_IMPACT_KEYS = [
  "area",
  "severity",
  "reason",
  "affectedRoutes",
  "affectedComponents",
  "decisionRequired",
] as const;
const APPROACH_KEYS = [
  "id",
  "title",
  "summary",
  "recommended",
  "pros",
  "cons",
  "uxImpact",
  "estimatedComplexity",
  "genomeFit",
  "likelyFiles",
  "status",
] as const;

function recordWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
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

function boundedStringArray(
  value: unknown,
  options: { maxItems: number; maxItemLength: number; nonEmpty?: boolean },
): value is string[] {
  return (
    Array.isArray(value) &&
    (!options.nonEmpty || value.length > 0) &&
    value.length <= options.maxItems &&
    value.every((entry) => boundedString(entry, options.maxItemLength))
  );
}

function isUXImpact(value: unknown): value is UXImpactWireOutput {
  if (!recordWithExactKeys(value, UX_IMPACT_KEYS)) return false;
  return (
    boundedString(value.area, 256) &&
    ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"].includes(
      value.severity as string,
    ) &&
    boundedString(value.reason, 2_000) &&
    boundedStringArray(value.affectedRoutes, {
      maxItems: 16,
      maxItemLength: 512,
    }) &&
    boundedStringArray(value.affectedComponents, {
      maxItems: 16,
      maxItemLength: 512,
    }) &&
    typeof value.decisionRequired === "boolean"
  );
}

function isApproach(value: unknown): value is DesignApproachWireOutput {
  if (!recordWithExactKeys(value, APPROACH_KEYS)) return false;
  return (
    boundedString(value.id, 128) &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.id) &&
    boundedString(value.title, 256) &&
    boundedString(value.summary, 2_000) &&
    typeof value.recommended === "boolean" &&
    boundedStringArray(value.pros, {
      maxItems: 12,
      maxItemLength: 1_000,
      nonEmpty: true,
    }) &&
    boundedStringArray(value.cons, {
      maxItems: 12,
      maxItemLength: 1_000,
      nonEmpty: true,
    }) &&
    Array.isArray(value.uxImpact) &&
    value.uxImpact.length > 0 &&
    value.uxImpact.length <= 8 &&
    value.uxImpact.every(isUXImpact) &&
    boundedString(value.estimatedComplexity, 256) &&
    boundedString(value.genomeFit, 2_000) &&
    boundedStringArray(value.likelyFiles, {
      maxItems: 32,
      maxItemLength: 512,
      nonEmpty: true,
    }) &&
    value.status === "PROPOSED"
  );
}

function assertEvolveWireOutput(value: unknown): EvolveWireOutput {
  if (
    !recordWithExactKeys(value, ["uxImpact", "approaches"]) ||
    !Array.isArray(value.uxImpact) ||
    value.uxImpact.length === 0 ||
    value.uxImpact.length > 8 ||
    !value.uxImpact.every(isUXImpact) ||
    !Array.isArray(value.approaches) ||
    value.approaches.length < 2 ||
    value.approaches.length > 3 ||
    !value.approaches.every(isApproach)
  ) {
    throw new Error("Codex EVOLVE returned invalid structured approaches");
  }
  const approaches = value.approaches as DesignApproachWireOutput[];
  if (approaches.filter((approach) => approach.recommended).length !== 1) {
    throw new Error("Codex EVOLVE must return exactly one recommended approach");
  }
  if (new Set(approaches.map((approach) => approach.id)).size !== approaches.length) {
    throw new Error("Codex EVOLVE returned duplicate approach ids");
  }
  return value as unknown as EvolveWireOutput;
}

function copyImpact(impact: UXImpactWireOutput): UXImpact {
  return {
    ...impact,
    affectedRoutes: [...impact.affectedRoutes],
    affectedComponents: [...impact.affectedComponents],
  };
}
