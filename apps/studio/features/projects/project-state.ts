import type { ProjectCapability, ProjectStatus } from "@design-sharingan/core";

export type ProjectSource = "LOCAL" | "GITHUB";
export type IntakeSource = "local" | "github";

export interface StudioProjectState {
  id: string;
  name: string;
  sourceType: ProjectSource;
  status: ProjectStatus;
  framework?: string;
  packageManager?: string;
  devCommand?: string;
  capabilities: ProjectCapability;
}

export type WorkspaceKind =
  | "overview"
  | "references"
  | "learn"
  | "execute"
  | "govern"
  | "reports"
  | "settings";

export interface WorkspaceDefinition {
  title: string;
  eyebrow: string;
  description: string;
  context: string;
  signals: readonly { title: string; detail: string }[];
}

export const workspaceDefinitions: Record<
  WorkspaceKind,
  WorkspaceDefinition
> = {
  overview: {
    title: "Overview",
    eyebrow: "PROJECT ORIENTATION",
    description:
      "Project health, visual evidence, and the next deliberate design action.",
    context: "Project health and recent design activity",
    signals: [
      { title: "Design Genome", detail: "Not initialized" },
      { title: "Registered screens", detail: "No screens registered" },
      { title: "Current drift", detail: "No audit evidence" },
      { title: "Latest visual run", detail: "No render captured" },
    ],
  },
  references: {
    title: "References",
    eyebrow: "VISUAL EVIDENCE",
    description:
      "Collect references as evidence, then record what to keep, reject, adapt, or invent.",
    context: "Reference library and compatibility evidence",
    signals: [
      { title: "Library", detail: "No references added" },
      { title: "Analysis", detail: "No active scan" },
      { title: "Compatibility", detail: "Awaiting evidence" },
      { title: "Decisions", detail: "No KRAI decisions" },
    ],
  },
  learn: {
    title: "Learn",
    eyebrow: "DESIGN INTELLIGENCE",
    description:
      "Turn selected evidence into a reviewable design approach without changing product code.",
    context: "References, goal, constraints, and Genome status",
    signals: [
      { title: "SCAN", detail: "Ready for reference analysis" },
      { title: "ASSIMILATE", detail: "Awaiting Design DNA" },
      { title: "EVOLVE", detail: "No feature brief" },
      { title: "VERIFY", detail: "No approved approach" },
    ],
  },
  execute: {
    title: "Execute",
    eyebrow: "BOUNDED CHANGE",
    description:
      "Prepare a concrete proposal, preserve human approval, and verify against a real render.",
    context: "Route, viewport, references, mode, and autonomy policy",
    signals: [
      { title: "Proposal", detail: "No approved approach" },
      { title: "Human gate", detail: "Required in Safe Mode" },
      { title: "Render", detail: "No fresh evidence" },
      { title: "Verification", detail: "Not verified" },
    ],
  },
  govern: {
    title: "Govern",
    eyebrow: "PRODUCT MEMORY",
    description:
      "Maintain human-readable design rules, registered screens, drift, and release evidence.",
    context: "Audit scope, evidence coverage, and missing evidence",
    signals: [
      { title: "Genome", detail: "Not initialized" },
      { title: "Registry", detail: "No screens registered" },
      { title: "Drift", detail: "No audit run" },
      { title: "Release", detail: "Evidence incomplete" },
    ],
  },
  reports: {
    title: "Reports",
    eyebrow: "EVIDENCE RECORD",
    description:
      "Review saved sessions, renders, findings, approvals, and product decisions.",
    context: "Session history and evidence projections",
    signals: [
      { title: "Sessions", detail: "No saved sessions" },
      { title: "Renders", detail: "No capture evidence" },
      { title: "Approvals", detail: "No human decisions" },
      { title: "Findings", detail: "No findings recorded" },
    ],
  },
  settings: {
    title: "Settings",
    eyebrow: "PROJECT BOUNDARIES",
    description:
      "Review detected configuration and the boundaries that constrain project operations.",
    context: "Project configuration and safety boundaries",
    signals: [
      { title: "Runtime", detail: "Detected during intake" },
      { title: "Protected paths", detail: "Default policy active" },
      { title: "Dependencies", detail: "Autonomous install disabled" },
      { title: "Deletion", detail: "Autonomous deletion disabled" },
    ],
  },
};

export function fallbackProjectState(projectId: string): StudioProjectState {
  return {
    id: projectId,
    name: `Project ${projectId.slice(0, 8)}`,
    sourceType: "LOCAL",
    status: "NEEDS_CONFIGURATION",
    capabilities: {
      canReadFiles: false,
      canWriteFiles: false,
      canRun: false,
      canRender: false,
      canCapture: false,
      canUseGit: false,
      canAudit: false,
    },
  };
}

export function projectSessionKey(projectId: string): string {
  return `design-sharingan:project:${projectId}`;
}
