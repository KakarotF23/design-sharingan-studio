import type {
  DesignDecision,
  DesignGenome,
  ScreenRecord,
} from "@design-sharingan/core";

export const GOVERNANCE_SCHEMA_VERSION = 1 as const;
export const GOVERNANCE_METADATA_PREFIX = "<!-- design-sharingan-metadata:";
export const GOVERNANCE_METADATA_SUFFIX = " -->";

export interface GenomeMetadata {
  schemaVersion: typeof GOVERNANCE_SCHEMA_VERSION;
  kind: "DESIGN_GENOME";
  projectId: string;
  entityId: string;
  revision: number;
  status: DesignGenome["status"];
  approvedBy?: string;
  approvedAt?: string;
  value: DesignGenome;
}

export interface ScreenRegistryMetadata {
  schemaVersion: typeof GOVERNANCE_SCHEMA_VERSION;
  kind: "SCREEN_REGISTRY";
  projectId: string;
  entityId: string;
  revision: number;
  records: ScreenRecord[];
}

export interface DesignDecisionsMetadata {
  schemaVersion: typeof GOVERNANCE_SCHEMA_VERSION;
  kind: "DESIGN_DECISIONS";
  projectId: string;
  entityId: string;
  revision: number;
  decisions: DesignDecision[];
}

export type GovernanceMetadata =
  | GenomeMetadata
  | ScreenRegistryMetadata
  | DesignDecisionsMetadata;

const MAX_ID_LENGTH = 128;
const MAX_SHORT_TEXT_LENGTH = 512;
const MAX_RULE_LENGTH = 1_000;
const MAX_RULES = 64;
const MAX_RECORDS = 512;

function metadataLine(metadata: GovernanceMetadata): string {
  const json = JSON.stringify(metadata)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("--", "\\u002d\\u002d");
  return `${GOVERNANCE_METADATA_PREFIX}${json}${GOVERNANCE_METADATA_SUFFIX}`;
}

function markdownList(values: readonly string[], emptyLabel = "None recorded."): string {
  return values.length === 0
    ? `_${emptyLabel}_`
    : values.map((value) => `- ${value}`).join("\n");
}

export function renderGenome(metadata: GenomeMetadata): string {
  const genome = metadata.value;
  return `${metadataLine(metadata)}
# Design Genome

**Status:** ${genome.status}
**Version:** ${genome.version}
**Machine identity:** ${metadata.entityId}

This document is human-readable product knowledge. A DRAFT Genome remains non-authoritative until a local user explicitly approves it.

## Product Identity

${genome.productIdentity}

## UX Invariants

${markdownList(genome.uxInvariants)}

## Visual Invariants

${markdownList(genome.visualInvariants)}

## Motion Rules

${markdownList(genome.motionRules)}

## Accessibility Rules

${markdownList(genome.accessibilityRules)}

## Component DNA

${markdownList(genome.componentDNA)}

## Screen Families

${markdownList(genome.screenFamilies)}

## Content Voice

${markdownList(genome.contentVoice)}

## Intentional Exceptions

${markdownList(genome.intentionalExceptions)}

## Unconfirmed Rules

${markdownList(genome.unconfirmedRules, "No unconfirmed rules recorded.")}
`;
}

export function renderScreenRegistry(metadata: ScreenRegistryMetadata): string {
  const records = metadata.records
    .map(
      (record) => `## ${record.name}

- **Route:** \`${record.route}\`
- **Family:** ${record.family}
- **Drift status:** ${record.driftStatus}
- **Last verified:** ${record.lastVerified ?? "NOT VERIFIED"}

### Inherited Rules

${markdownList(record.inheritedRules)}

### Intentional Exceptions

${markdownList(record.exceptions)}

### Required States

${markdownList(record.requiredStates)}

### Evidence

${markdownList(record.evidence, "No evidence recorded.")}`,
    )
    .join("\n\n---\n\n");

  return `${metadataLine(metadata)}
# Screen Registry

**Machine identity:** ${metadata.entityId}
**Registered screens:** ${metadata.records.length}

${records || "_No representative screens registered._"}
`;
}

export function renderDesignDecisions(metadata: DesignDecisionsMetadata): string {
  const decisions = metadata.decisions
    .map(
      (decision) => `## ${decision.decision}

- **ID:** ${decision.id}
- **Date:** ${decision.date}
- **Status:** ${decision.status}
- **Scope:** ${decision.scope}
- **Approved by:** ${decision.approvedBy ?? "Not approved"}
- **Migration required:** ${decision.migrationRequired ? "Yes" : "No"}

### Reason

${decision.reason}

### Alternatives

${markdownList(decision.alternatives)}

### Affected Screens

${markdownList(decision.affectedScreens)}

### Affected Components

${markdownList(decision.affectedComponents)}

### Genome Changes

${markdownList(decision.genomeChanges)}`,
    )
    .join("\n\n---\n\n");

  return `${metadataLine(metadata)}
# Design Decisions

**Machine identity:** ${metadata.entityId}
**Recorded decisions:** ${metadata.decisions.length}

${decisions || "_No design decisions recorded._"}
`;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} does not match the exact governance schema`);
  }
}

function boundedString(value: unknown, label: string, max = MAX_RULE_LENGTH): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function optionalBoundedString(value: unknown, label: string, max = MAX_RULE_LENGTH): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, max);
}

function safeId(value: unknown, label: string): string {
  const id = boundedString(value, label, MAX_ID_LENGTH);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`${label} must be a safe identifier`);
  }
  return id;
}

function boundedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_RULES) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value.map((entry, index) => boundedString(entry, `${label}[${index}]`));
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Governance revision must be a positive integer");
  }
  return value as number;
}

function assertBaseMetadata(
  value: Record<string, unknown>,
  kind: GovernanceMetadata["kind"],
): void {
  if (value.schemaVersion !== GOVERNANCE_SCHEMA_VERSION || value.kind !== kind) {
    throw new Error("Governance metadata kind or schema version is invalid");
  }
  safeId(value.projectId, "Governance project identity");
  safeId(value.entityId, "Governance entity identity");
  positiveRevision(value.revision);
}

function parseGenome(value: unknown): DesignGenome {
  const genome = objectValue(value, "Design Genome");
  exactKeys(
    genome,
    [
      "version",
      "status",
      "productIdentity",
      "uxInvariants",
      "visualInvariants",
      "motionRules",
      "accessibilityRules",
      "componentDNA",
      "screenFamilies",
      "contentVoice",
      "intentionalExceptions",
      "unconfirmedRules",
    ],
    [],
    "Design Genome",
  );
  const status = genome.status;
  if (status !== "DRAFT" && status !== "APPROVED") {
    throw new Error("Design Genome status is invalid");
  }
  return {
    version: boundedString(genome.version, "Design Genome version", MAX_SHORT_TEXT_LENGTH),
    status,
    productIdentity: boundedString(
      genome.productIdentity,
      "Design Genome product identity",
      4_000,
    ),
    uxInvariants: boundedStringArray(genome.uxInvariants, "UX invariants"),
    visualInvariants: boundedStringArray(genome.visualInvariants, "Visual invariants"),
    motionRules: boundedStringArray(genome.motionRules, "Motion rules"),
    accessibilityRules: boundedStringArray(genome.accessibilityRules, "Accessibility rules"),
    componentDNA: boundedStringArray(genome.componentDNA, "Component DNA"),
    screenFamilies: boundedStringArray(genome.screenFamilies, "Screen families"),
    contentVoice: boundedStringArray(genome.contentVoice, "Content voice"),
    intentionalExceptions: boundedStringArray(
      genome.intentionalExceptions,
      "Intentional exceptions",
    ),
    unconfirmedRules: boundedStringArray(genome.unconfirmedRules, "Unconfirmed rules"),
  };
}

function parseScreenRecord(value: unknown): ScreenRecord {
  const record = objectValue(value, "Screen record");
  exactKeys(
    record,
    [
      "id",
      "route",
      "name",
      "family",
      "inheritedRules",
      "exceptions",
      "requiredStates",
      "evidence",
      "driftStatus",
    ],
    ["lastVerified"],
    "Screen record",
  );
  return {
    id: safeId(record.id, "Screen record identity"),
    route: boundedString(record.route, "Screen route", MAX_SHORT_TEXT_LENGTH),
    name: boundedString(record.name, "Screen name", MAX_SHORT_TEXT_LENGTH),
    family: boundedString(record.family, "Screen family", MAX_SHORT_TEXT_LENGTH),
    inheritedRules: boundedStringArray(record.inheritedRules, "Inherited rules"),
    exceptions: boundedStringArray(record.exceptions, "Screen exceptions"),
    requiredStates: boundedStringArray(record.requiredStates, "Required states"),
    evidence: boundedStringArray(record.evidence, "Screen evidence"),
    driftStatus: boundedString(record.driftStatus, "Drift status", MAX_SHORT_TEXT_LENGTH),
    lastVerified: optionalBoundedString(record.lastVerified, "Last verification", MAX_SHORT_TEXT_LENGTH),
  };
}

function parseDesignDecision(value: unknown): DesignDecision {
  const decision = objectValue(value, "Design decision");
  exactKeys(
    decision,
    [
      "id",
      "date",
      "status",
      "scope",
      "decision",
      "reason",
      "alternatives",
      "affectedScreens",
      "affectedComponents",
      "migrationRequired",
      "genomeChanges",
    ],
    ["approvedBy"],
    "Design decision",
  );
  if (typeof decision.migrationRequired !== "boolean") {
    throw new Error("Design decision migration flag must be boolean");
  }
  return {
    id: safeId(decision.id, "Design decision identity"),
    date: boundedString(decision.date, "Design decision date", MAX_SHORT_TEXT_LENGTH),
    status: boundedString(decision.status, "Design decision status", MAX_SHORT_TEXT_LENGTH),
    scope: boundedString(decision.scope, "Design decision scope", MAX_SHORT_TEXT_LENGTH),
    decision: boundedString(decision.decision, "Design decision", 4_000),
    reason: boundedString(decision.reason, "Design decision reason", 4_000),
    alternatives: boundedStringArray(decision.alternatives, "Design decision alternatives"),
    affectedScreens: boundedStringArray(decision.affectedScreens, "Affected screens"),
    affectedComponents: boundedStringArray(decision.affectedComponents, "Affected components"),
    migrationRequired: decision.migrationRequired,
    genomeChanges: boundedStringArray(decision.genomeChanges, "Genome changes"),
    approvedBy: optionalBoundedString(
      decision.approvedBy,
      "Design decision approver",
      MAX_SHORT_TEXT_LENGTH,
    ),
  };
}

export function parseGovernanceMetadata(markdown: string): GovernanceMetadata {
  const lineEnd = markdown.indexOf("\n");
  const firstLine = lineEnd === -1 ? markdown : markdown.slice(0, lineEnd);
  if (
    !firstLine.startsWith(GOVERNANCE_METADATA_PREFIX) ||
    !firstLine.endsWith(GOVERNANCE_METADATA_SUFFIX)
  ) {
    throw new Error("Governance document metadata is missing");
  }
  const json = firstLine.slice(
    GOVERNANCE_METADATA_PREFIX.length,
    -GOVERNANCE_METADATA_SUFFIX.length,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Governance document metadata is malformed");
  }
  const metadata = objectValue(parsed, "Governance metadata");
  if (metadata.kind === "DESIGN_GENOME") {
    exactKeys(
      metadata,
      ["schemaVersion", "kind", "projectId", "entityId", "revision", "status", "value"],
      ["approvedBy", "approvedAt"],
      "Design Genome metadata",
    );
    assertBaseMetadata(metadata, "DESIGN_GENOME");
    const value = parseGenome(metadata.value);
    if (metadata.status !== value.status) {
      throw new Error("Design Genome status metadata is inconsistent");
    }
    if (value.status === "APPROVED") {
      boundedString(metadata.approvedBy, "Genome approver", MAX_SHORT_TEXT_LENGTH);
      boundedString(metadata.approvedAt, "Genome approval time", MAX_SHORT_TEXT_LENGTH);
    } else if (metadata.approvedBy !== undefined || metadata.approvedAt !== undefined) {
      throw new Error("Draft Genome cannot contain approval metadata");
    }
    return {
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      kind: "DESIGN_GENOME",
      projectId: metadata.projectId as string,
      entityId: metadata.entityId as string,
      revision: metadata.revision as number,
      status: value.status,
      ...(metadata.approvedBy === undefined
        ? {}
        : { approvedBy: metadata.approvedBy as string }),
      ...(metadata.approvedAt === undefined
        ? {}
        : { approvedAt: metadata.approvedAt as string }),
      value,
    };
  }
  if (metadata.kind === "SCREEN_REGISTRY") {
    exactKeys(
      metadata,
      ["schemaVersion", "kind", "projectId", "entityId", "revision", "records"],
      [],
      "Screen Registry metadata",
    );
    assertBaseMetadata(metadata, "SCREEN_REGISTRY");
    if (!Array.isArray(metadata.records) || metadata.records.length > MAX_RECORDS) {
      throw new Error("Screen Registry records must be bounded");
    }
    const records = metadata.records.map(parseScreenRecord);
    if (new Set(records.map((record) => record.id)).size !== records.length) {
      throw new Error("Screen Registry record identities must be unique");
    }
    return {
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      kind: "SCREEN_REGISTRY",
      projectId: metadata.projectId as string,
      entityId: metadata.entityId as string,
      revision: metadata.revision as number,
      records,
    };
  }
  if (metadata.kind === "DESIGN_DECISIONS") {
    exactKeys(
      metadata,
      ["schemaVersion", "kind", "projectId", "entityId", "revision", "decisions"],
      [],
      "Design Decisions metadata",
    );
    assertBaseMetadata(metadata, "DESIGN_DECISIONS");
    if (!Array.isArray(metadata.decisions) || metadata.decisions.length > MAX_RECORDS) {
      throw new Error("Design Decisions must be bounded");
    }
    const decisions = metadata.decisions.map(parseDesignDecision);
    if (new Set(decisions.map((decision) => decision.id)).size !== decisions.length) {
      throw new Error("Design Decision identities must be unique");
    }
    return {
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      kind: "DESIGN_DECISIONS",
      projectId: metadata.projectId as string,
      entityId: metadata.entityId as string,
      revision: metadata.revision as number,
      decisions,
    };
  }
  throw new Error("Governance document kind is invalid");
}

export function assertGenome(value: unknown): DesignGenome {
  return parseGenome(value);
}

export function assertScreenRecords(value: unknown): ScreenRecord[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) {
    throw new Error("Screen Registry records must be bounded");
  }
  const records = value.map(parseScreenRecord);
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error("Screen Registry record identities must be unique");
  }
  return records;
}

export function assertDesignDecisions(value: unknown): DesignDecision[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) {
    throw new Error("Design Decisions must be bounded");
  }
  const decisions = value.map(parseDesignDecision);
  if (new Set(decisions.map((decision) => decision.id)).size !== decisions.length) {
    throw new Error("Design Decision identities must be unique");
  }
  return decisions;
}
