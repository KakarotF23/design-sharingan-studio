import { posix } from "node:path";
import type { CodexAgentRunInput } from "@design-sharingan/agent-runtime";
import type {
  ChangeProposal,
  DesignApproach,
  FeatureBrief,
  UXImpact,
} from "@design-sharingan/core";

const shortString = {
  type: "string",
  minLength: 1,
  maxLength: 256,
} as const;
const longString = {
  type: "string",
  minLength: 1,
  maxLength: 4_000,
} as const;
const locatorArray = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 512 },
  maxItems: 64,
} as const;
const evidenceArray = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 1_000 },
  maxItems: 32,
} as const;
const uxImpactSchema = {
  type: "object",
  properties: {
    area: shortString,
    severity: {
      type: "string",
      enum: ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"],
    },
    reason: { type: "string", minLength: 1, maxLength: 2_000 },
    affectedRoutes: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 512 },
      maxItems: 16,
    },
    affectedComponents: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 512 },
      maxItems: 16,
    },
    decisionRequired: { type: "boolean" },
  },
  required: [
    "area",
    "severity",
    "reason",
    "affectedRoutes",
    "affectedComponents",
    "decisionRequired",
  ],
  additionalProperties: false,
} as const;

export const CHANGE_PROPOSAL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: longString,
    reason: longString,
    filesToCreate: locatorArray,
    filesToModify: locatorArray,
    filesToDelete: locatorArray,
    componentsAffected: evidenceArray,
    screensAffected: locatorArray,
    uxImpact: {
      type: "array",
      items: uxImpactSchema,
      minItems: 1,
      maxItems: 16,
    },
    visualImpact: longString,
    riskLevel: {
      type: "string",
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
    },
    requiresHumanApproval: { type: "boolean", const: true },
    policyViolations: evidenceArray,
    status: { type: "string", enum: ["PROPOSED"] },
  },
  required: [
    "summary",
    "reason",
    "filesToCreate",
    "filesToModify",
    "filesToDelete",
    "componentsAffected",
    "screensAffected",
    "uxImpact",
    "visualImpact",
    "riskLevel",
    "requiresHumanApproval",
    "policyViolations",
    "status",
  ],
  additionalProperties: false,
} as const;

export interface ProposalProjectContext {
  name: string;
  framework?: string;
  routes: readonly string[];
  componentDirectories: readonly string[];
}

export interface ProposalAgent {
  run<TStructured = unknown>(input: CodexAgentRunInput): Promise<{
    threadId: string;
    structured: TStructured | null;
  }>;
}

export interface GenerateChangeProposalInput {
  sessionId: string;
  designApproach: DesignApproach;
  featureBrief: FeatureBrief;
  analysisWorkingDirectory: string;
  projectContext: ProposalProjectContext;
  revisionRequest?: string;
  threadId?: string;
}

interface ChangeProposalWireOutput {
  summary: string;
  reason: string;
  filesToCreate: string[];
  filesToModify: string[];
  filesToDelete: string[];
  componentsAffected: string[];
  screensAffected: string[];
  uxImpact: UXImpact[];
  visualImpact: string;
  riskLevel: ChangeProposal["riskLevel"];
  requiresHumanApproval: true;
  policyViolations: string[];
  status: "PROPOSED";
}

const wireKeys = [
  "summary",
  "reason",
  "filesToCreate",
  "filesToModify",
  "filesToDelete",
  "componentsAffected",
  "screensAffected",
  "uxImpact",
  "visualImpact",
  "riskLevel",
  "requiresHumanApproval",
  "policyViolations",
  "status",
] as const;

const uxImpactKeys = [
  "area",
  "severity",
  "reason",
  "affectedRoutes",
  "affectedComponents",
  "decisionRequired",
] as const;

function exactRecord(
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

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum
  );
}

function boundedStrings(
  value: unknown,
  options: { maximumItems: number; maximumLength: number; nonEmpty?: boolean },
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= options.maximumItems &&
    (options.nonEmpty !== true || value.length > 0) &&
    value.every((item) => boundedString(item, options.maximumLength))
  );
}

function isUxImpact(value: unknown): value is UXImpact {
  return (
    exactRecord(value, uxImpactKeys) &&
    boundedString(value.area, 256) &&
    ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"].includes(
      value.severity as string,
    ) &&
    boundedString(value.reason, 2_000) &&
    boundedStrings(value.affectedRoutes, {
      maximumItems: 16,
      maximumLength: 512,
    }) &&
    boundedStrings(value.affectedComponents, {
      maximumItems: 16,
      maximumLength: 512,
    }) &&
    typeof value.decisionRequired === "boolean"
  );
}

function safeRelativePath(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= 512 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value !== "." &&
    value !== ".." &&
    !value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..") &&
    posix.normalize(value) === value
  );
}

function uniqueSafePaths(value: unknown): value is string[] {
  return (
    boundedStrings(value, { maximumItems: 64, maximumLength: 512 }) &&
    value.every(safeRelativePath) &&
    new Set(value).size === value.length
  );
}

function assertWireOutput(value: unknown): ChangeProposalWireOutput {
  if (
    !exactRecord(value, wireKeys) ||
    !boundedString(value.summary, 4_000) ||
    !boundedString(value.reason, 4_000) ||
    !uniqueSafePaths(value.filesToCreate) ||
    !uniqueSafePaths(value.filesToModify) ||
    !uniqueSafePaths(value.filesToDelete) ||
    !boundedStrings(value.componentsAffected, {
      maximumItems: 32,
      maximumLength: 1_000,
    }) ||
    !boundedStrings(value.screensAffected, {
      maximumItems: 64,
      maximumLength: 512,
    }) ||
    !Array.isArray(value.uxImpact) ||
    value.uxImpact.length === 0 ||
    value.uxImpact.length > 16 ||
    !value.uxImpact.every(isUxImpact) ||
    !boundedString(value.visualImpact, 4_000) ||
    !["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(
      value.riskLevel as string,
    ) ||
    value.requiresHumanApproval !== true ||
    !boundedStrings(value.policyViolations, {
      maximumItems: 32,
      maximumLength: 1_000,
    }) ||
    value.status !== "PROPOSED"
  ) {
    throw new Error("Codex returned an invalid structured Change Proposal");
  }

  const allPaths = [
    ...value.filesToCreate,
    ...value.filesToModify,
    ...value.filesToDelete,
  ];
  if (
    allPaths.length === 0 ||
    allPaths.length > 128 ||
    new Set(allPaths).size !== allPaths.length
  ) {
    throw new Error("Codex returned an invalid structured Change Proposal");
  }
  return value as unknown as ChangeProposalWireOutput;
}

function buildProposalPrompt(input: GenerateChangeProposalInput): string {
  const evidence = {
    featureBrief: input.featureBrief,
    approvedDesignApproach: input.designApproach,
    project: input.projectContext,
    revisionRequest: input.revisionRequest?.trim() || undefined,
  };
  return [
    "Prepare a Safe Mode Change Proposal for the approved Design Approach.",
    "This is a read-only planning turn. Do not write, edit, create, delete, rename, or execute any project file or command.",
    "Return the exact files to create, modify, and delete; components and screens affected; the reason; bounded risk; UX impact; visual impact; and policy violations.",
    "Preserve UX integrity, product consistency, accessibility, and the approved direction. Do not install dependencies, change navigation architecture, change persistent data models, or touch protected/runtime/governance/environment paths.",
    "Every mutation requires a new explicit human approval. Return only the requested structured output with no undeclared keys.",
    `Evidence:\n${JSON.stringify(evidence, null, 2)}`,
  ].join("\n\n");
}

export async function generateChangeProposal(
  input: GenerateChangeProposalInput,
  dependencies: { agent: ProposalAgent; createId(): string },
): Promise<{ proposal: ChangeProposal; threadId: string }> {
  if (
    !boundedString(input.sessionId, 128) ||
    !boundedString(input.analysisWorkingDirectory, 4_096) ||
    !boundedString(input.projectContext.name, 256) ||
    (input.threadId !== undefined && !boundedString(input.threadId, 256)) ||
    (input.revisionRequest !== undefined &&
      Buffer.byteLength(input.revisionRequest, "utf8") > 2_000)
  ) {
    throw new Error("Safe Mode proposal input is invalid");
  }
  const result = await dependencies.agent.run<ChangeProposalWireOutput>({
    workingDirectory: input.analysisWorkingDirectory,
    prompt: buildProposalPrompt(input),
    outputSchema: CHANGE_PROPOSAL_OUTPUT_SCHEMA,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  });
  const wire = assertWireOutput(result.structured);
  const proposalId = dependencies.createId();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(proposalId)) {
    throw new Error("Safe Mode proposal id is invalid");
  }
  if (!boundedString(result.threadId, 256)) {
    throw new Error("Codex returned an invalid proposal thread id");
  }
  if (input.threadId !== undefined && result.threadId !== input.threadId) {
    throw new Error("Codex did not continue the proposal thread");
  }

  return {
    proposal: {
      id: proposalId,
      sessionId: input.sessionId,
      summary: wire.summary,
      reason: wire.reason,
      filesToCreate: [...wire.filesToCreate],
      filesToModify: [...wire.filesToModify],
      filesToDelete: [...wire.filesToDelete],
      componentsAffected: [...wire.componentsAffected],
      screensAffected: [...wire.screensAffected],
      uxImpact: wire.uxImpact.map((impact) => ({
        ...impact,
        affectedRoutes: [...impact.affectedRoutes],
        affectedComponents: [...impact.affectedComponents],
      })),
      visualImpact: wire.visualImpact,
      riskLevel: wire.riskLevel,
      requiresHumanApproval: true,
      policyViolations: [...wire.policyViolations],
      status: "PROPOSED",
    },
    threadId: result.threadId,
  };
}
