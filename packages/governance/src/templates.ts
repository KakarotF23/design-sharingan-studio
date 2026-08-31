import { createHash } from "node:crypto";
import {
  normalizeGovernanceRoute,
  type DesignDecision,
  type DesignGenome,
  type DriftAuditScopeEntry,
  type DriftFinding,
  type DriftReport,
  type GovernanceClaimCitation,
  type GovernanceClaimCategory,
  type GovernanceInspectedScope,
  type ScreenRecord,
} from "@design-sharingan/core";

export const GOVERNANCE_SCHEMA_VERSION = 1 as const;
export const GOVERNANCE_METADATA_PREFIX = "<!-- design-sharingan-metadata:";
export const GOVERNANCE_METADATA_SUFFIX = " -->";

export interface GenomeAuthorityProof {
  kind: "GENOME_AUTHORITY";
  projectId: string;
  rootFingerprint: string;
  genomeEntityId: string;
  genomeVersion: string;
  approvedDraftRevision: number;
  documentRevision: number;
  payloadHash: string;
  approvedBy: "local-user";
  approvedAt: string;
  signature: string;
}

export interface GenomeMetadata {
  schemaVersion: typeof GOVERNANCE_SCHEMA_VERSION;
  kind: "DESIGN_GENOME";
  projectId: string;
  entityId: string;
  revision: number;
  status: DesignGenome["status"];
  authority?: GenomeAuthorityProof;
  inspectedScope: GovernanceInspectedScope;
  claimCitations: GovernanceClaimCitation[];
  value: DesignGenome;
}

export interface ScreenRegistryMetadata {
  schemaVersion: typeof GOVERNANCE_SCHEMA_VERSION;
  kind: "SCREEN_REGISTRY";
  projectId: string;
  entityId: string;
  revision: number;
  genomeEntityId: string;
  genomeVersion: string;
  genomeRevision: number;
  evidenceIds: string[];
  records: ScreenRecord[];
}

export interface DecisionApprovalProof {
  kind: "DESIGN_DECISION_APPROVAL";
  projectId: string;
  rootFingerprint: string;
  genomeEntityId: string;
  decisionId: string;
  decisionHash: string;
  approvedBy: "local-user";
  approvedAt: string;
  signature: string;
}

export interface DesignDecisionsMetadata {
  schemaVersion: typeof GOVERNANCE_SCHEMA_VERSION;
  kind: "DESIGN_DECISIONS";
  projectId: string;
  entityId: string;
  revision: number;
  genomeEntityId: string;
  genomeVersion: string;
  genomeRevision: number;
  approvalProofs: DecisionApprovalProof[];
  decisions: DesignDecision[];
}

export interface DriftReportMetadata {
  schemaVersion: typeof GOVERNANCE_SCHEMA_VERSION;
  kind: "DRIFT_REPORT";
  projectId: string;
  entityId: string;
  revision: number;
  genomeEntityId: string;
  genomeVersion: string;
  genomeRevision: number;
  registryEntityId: string;
  registryRevision: number;
  evidenceIds: string[];
  auditedAt: string;
  value: DriftReport;
}

export type GovernanceMetadata = GenomeMetadata | ScreenRegistryMetadata | DesignDecisionsMetadata | DriftReportMetadata;

export interface ScreenRelationContext {
  genome: DesignGenome;
  evidenceIds: readonly string[];
  evidenceRoutes?: Readonly<Record<string, string>>;
  authenticatedVerificationEvidenceIds?: readonly string[];
}

const MAX_ID_LENGTH = 128;
const MAX_SHORT_TEXT_LENGTH = 512;
const MAX_RULE_LENGTH = 1_000;
const MAX_RULES = 64;
const MAX_RECORDS = 512;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const EVIDENCE_ID_PATTERN = /^ev_[a-zA-Z0-9_-]{8,125}$/;

function metadataLine(metadata: GovernanceMetadata): string {
  const json = JSON.stringify(metadata)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("--", "\\u002d\\u002d");
  return `${GOVERNANCE_METADATA_PREFIX}${json}${GOVERNANCE_METADATA_SUFFIX}`;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function markdownList(values: readonly string[], emptyLabel = "None recorded."): string {
  return values.length === 0 ? `_${emptyLabel}_` : values.map((value) => `- ${quoted(value)}`).join("\n");
}

export function renderGenome(metadata: GenomeMetadata): string {
  const genome = metadata.value;
  return `${metadataLine(metadata)}
# Design Genome

**Status:** ${genome.status}
**Version:** ${quoted(genome.version)}
**Machine identity:** ${quoted(metadata.entityId)}
**Authority:** ${metadata.authority === undefined ? "NON_AUTHORITATIVE" : "AUTHORITATIVE"}
**Rule payload hash:** ${genomePayloadHash(genome)}
**Inspected scope:** REPRESENTATIVE

This document is human-readable product knowledge. A DRAFT Genome remains non-authoritative until a local user explicitly approves its exact revision and rule payload.

## Inspected Routes

${markdownList(metadata.inspectedScope.routes, "No representative routes recorded.")}

## Evidence Catalog Citations

${markdownList(metadata.inspectedScope.evidenceIds, "No evidence citations recorded.")}

## Auditable Claim Citations

${markdownList(metadata.claimCitations.map((citation) => JSON.stringify(citation)), "No claims recorded.")}

## Product Identity

${quoted(genome.productIdentity)}

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
  const records = metadata.records.map((record) => `## ${quoted(record.name)}

- **ID:** ${quoted(record.id)}
- **Route:** ${quoted(record.route)}
- **Family:** ${quoted(record.family)}
- **Drift status:** ${record.driftStatus}
- **Last verified:** ${record.lastVerified === undefined ? "NOT_VERIFIED" : quoted(record.lastVerified)}

### Inherited Rules

${markdownList(record.inheritedRules)}

### Intentional Exceptions

${markdownList(record.exceptions)}

### Required States

${markdownList(record.requiredStates)}

### Evidence

${markdownList(record.evidence, "No evidence recorded.")}`).join("\n\n---\n\n");
  return `${metadataLine(metadata)}
# Screen Registry

**Machine identity:** ${quoted(metadata.entityId)}
**Genome identity:** ${quoted(metadata.genomeEntityId)}
**Genome version:** ${quoted(metadata.genomeVersion)}
**Genome revision:** ${metadata.genomeRevision}
**Registered screens:** ${metadata.records.length}

${records || "_No representative screens registered._"}
`;
}

export function renderDesignDecisions(metadata: DesignDecisionsMetadata): string {
  const decisions = metadata.decisions.map((decision) => `## ${quoted(decision.decision)}

- **ID:** ${quoted(decision.id)}
- **Date:** ${quoted(decision.date)}
- **Status:** ${decision.status}
- **Scope:** ${quoted(decision.scope)}
- **Approved by:** ${decision.approvedBy === undefined ? "Not approved" : quoted(decision.approvedBy)}
- **Migration required:** ${decision.migrationRequired ? "Yes" : "No"}

### Reason

${quoted(decision.reason)}

### Alternatives

${markdownList(decision.alternatives)}

### Affected Screens

${markdownList(decision.affectedScreens)}

### Affected Components

${markdownList(decision.affectedComponents)}

### Genome Changes

${markdownList(decision.genomeChanges)}`).join("\n\n---\n\n");
  return `${metadataLine(metadata)}
# Design Decisions

**Machine identity:** ${quoted(metadata.entityId)}
**Genome identity:** ${quoted(metadata.genomeEntityId)}
**Genome version:** ${quoted(metadata.genomeVersion)}
**Genome revision:** ${metadata.genomeRevision}
**Recorded decisions:** ${metadata.decisions.length}

${decisions || "_No design decisions recorded._"}
`;
}

export function renderDriftReport(metadata: DriftReportMetadata): string {
  const report = metadata.value;
  const scope = report.expectedScope.map(({ screen, states }) =>
    `- **${quoted(screen)}:** ${markdownList(states, "No required states.")}`,
  ).join("\n");
  const findings = report.findings.map((finding) => `## ${finding.severity} / ${finding.category}

- **Scope:** ${quoted(finding.scope)}
- **Genome rule:** ${quoted(finding.genomeRuleId)}
- **Evidence IDs:** ${markdownList(finding.evidenceIds, "No authenticated evidence IDs.")}
- **Expected rule:** ${quoted(finding.expectedRule)}
- **Decision required:** ${finding.requiresDesignDecision ? "Yes" : "No"}
- **Status:** ${quoted(finding.status)}

### Observed Evidence

${markdownList(finding.observedEvidence)}

### Why It Matters

${quoted(finding.whyItMatters)}

### Smallest Coherent Fix

${quoted(finding.recommendedFix)}`).join("\n\n---\n\n");
  return `${metadataLine(metadata)}
# Drift Report

**Status:** ${report.overallStatus}
**Requested scope:** ${report.requestedScope}
**Audited at:** ${quoted(metadata.auditedAt)}
**Genome identity:** ${quoted(metadata.genomeEntityId)}
**Genome version:** ${quoted(metadata.genomeVersion)}
**Genome revision:** ${metadata.genomeRevision}
**Registry revision:** ${metadata.registryRevision}

This report records only explicitly enumerated rendered evidence. Unavailable scope is not silently inferred as a pass, and repeated drift remains a Design Decision candidate rather than a Genome rewrite.

## Expected Scope

${scope || "_No scope was enumerated._"}

## Inspected Scope

${markdownList(report.inspectedScope, "No screen states were inspected.")}

## Unavailable Scope

${markdownList(report.unavailableScope, "No unavailable scope recorded.")}

## Unverified Scope

${markdownList(report.unverifiedScope, "No unverified scope recorded.")}

## Authenticated Evidence

${markdownList(metadata.evidenceIds, "No authenticated evidence recorded.")}

${findings || "## Findings\n\n_No drift findings recorded._"}
`;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = [], label: string): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} does not match the exact governance schema`);
  }
}

function boundedString(value: unknown, label: string, max = MAX_RULE_LENGTH): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new Error(`${label} must be a non-empty bounded string`);
  return value;
}

function optionalBoundedString(value: unknown, label: string, max = MAX_RULE_LENGTH): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, max);
}

function safeId(value: unknown, label: string): string {
  const id = boundedString(value, label, MAX_ID_LENGTH);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error(`${label} must be a safe identifier`);
  return id;
}

function evidenceId(value: unknown, label: string): string {
  const id = boundedString(value, label, MAX_ID_LENGTH);
  if (!EVIDENCE_ID_PATTERN.test(id)) throw new Error(`${label} must be a server-controlled evidence identifier`);
  return id;
}

function boundedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_RULES) throw new Error(`${label} must be a bounded array`);
  return value.map((entry, index) => boundedString(entry, `${label}[${index}]`));
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Governance revision must be a positive integer");
  return value as number;
}

function isNextRevision(previous: number, next: number): boolean {
  return previous < Number.MAX_SAFE_INTEGER && previous + 1 === next;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64);
  let canonical: string;
  try { canonical = new Date(timestamp).toISOString(); } catch { throw new Error(`${label} must be an exact ISO timestamp`); }
  if (canonical !== timestamp) throw new Error(`${label} must be an exact ISO timestamp`);
  return timestamp;
}

function hash(value: unknown, label: string): string {
  const digest = boundedString(value, label, 64);
  if (!HASH_PATTERN.test(digest)) throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}

const CLAIM_CATEGORIES = new Set<GovernanceClaimCategory>([
  "PRODUCT_IDENTITY", "UX_INVARIANT", "VISUAL_INVARIANT", "MOTION_RULE",
  "ACCESSIBILITY_RULE", "COMPONENT_DNA", "SCREEN_FAMILY", "CONTENT_VOICE",
]);

function parseClaimScope(value: unknown, label: string): { routes: string[] } {
  const scope = objectValue(value, label);
  exactKeys(scope, ["routes"], [], label);
  if (!Array.isArray(scope.routes) || scope.routes.length > MAX_RULES) {
    throw new Error(`${label} routes must be bounded`);
  }
  const routes = scope.routes.map(safeRoute);
  if (new Set(routes).size !== routes.length) throw new Error(`${label} routes must be unique`);
  return { routes };
}

function parseInspectedScope(value: unknown): GovernanceInspectedScope {
  const scope = objectValue(value, "Genome inspected scope");
  exactKeys(scope, ["representative", "routes", "evidenceIds"], [], "Genome inspected scope");
  if (scope.representative !== true) throw new Error("Genome inspected scope must remain representative");
  const routes = parseClaimScope({ routes: scope.routes }, "Genome inspected scope").routes;
  if (!Array.isArray(scope.evidenceIds) || scope.evidenceIds.length > MAX_RECORDS) {
    throw new Error("Genome inspected evidence must be bounded");
  }
  const evidenceIds = scope.evidenceIds.map((entry, index) => evidenceId(entry, `Inspected evidence[${index}]`));
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("Genome inspected evidence must be unique");
  return { representative: true, routes, evidenceIds };
}

function parseClaimCitation(value: unknown): GovernanceClaimCitation {
  const citation = objectValue(value, "Genome claim citation");
  exactKeys(citation, ["claimType", "category", "statement", "confidence", "requestedConfidence", "scope", "evidenceIds"], [], "Genome claim citation");
  if (citation.claimType !== "PRODUCT_IDENTITY" && citation.claimType !== "RULE") throw new Error("Genome claim type is invalid");
  if (!CLAIM_CATEGORIES.has(citation.category as GovernanceClaimCategory)) throw new Error("Genome claim category is invalid");
  if ((citation.claimType === "PRODUCT_IDENTITY") !== (citation.category === "PRODUCT_IDENTITY")) throw new Error("Genome claim type and category are inconsistent");
  if (citation.confidence !== "CONFIRMED" && citation.confidence !== "UNCONFIRMED") throw new Error("Genome claim confidence is invalid");
  if (citation.requestedConfidence !== "CONFIRMED" && citation.requestedConfidence !== "UNCONFIRMED") throw new Error("Genome requested claim confidence is invalid");
  if (!Array.isArray(citation.evidenceIds) || citation.evidenceIds.length > MAX_RULES) throw new Error("Genome claim evidence must be bounded");
  return {
    claimType: citation.claimType,
    category: citation.category as GovernanceClaimCategory,
    statement: boundedString(citation.statement, "Genome claim statement"),
    confidence: citation.confidence,
    requestedConfidence: citation.requestedConfidence,
    scope: parseClaimScope(citation.scope, "Genome claim scope"),
    evidenceIds: citation.evidenceIds.map((entry, index) => evidenceId(entry, `Genome claim evidence[${index}]`)),
  };
}

function assertBaseMetadata(value: Record<string, unknown>, kind: GovernanceMetadata["kind"]): void {
  if (value.schemaVersion !== GOVERNANCE_SCHEMA_VERSION || value.kind !== kind) throw new Error("Governance metadata kind or schema version is invalid");
  safeId(value.projectId, "Governance project identity");
  safeId(value.entityId, "Governance entity identity");
  positiveRevision(value.revision);
}

function parseGenome(value: unknown): DesignGenome {
  const genome = objectValue(value, "Design Genome");
  exactKeys(genome, ["version", "status", "productIdentity", "uxInvariants", "visualInvariants", "motionRules", "accessibilityRules", "componentDNA", "screenFamilies", "contentVoice", "intentionalExceptions", "unconfirmedRules"], [], "Design Genome");
  if (genome.status !== "DRAFT" && genome.status !== "APPROVED") throw new Error("Design Genome status is invalid");
  return {
    version: boundedString(genome.version, "Design Genome version", MAX_SHORT_TEXT_LENGTH),
    status: genome.status,
    productIdentity: boundedString(genome.productIdentity, "Design Genome product identity", 4_000),
    uxInvariants: boundedStringArray(genome.uxInvariants, "UX invariants"),
    visualInvariants: boundedStringArray(genome.visualInvariants, "Visual invariants"),
    motionRules: boundedStringArray(genome.motionRules, "Motion rules"),
    accessibilityRules: boundedStringArray(genome.accessibilityRules, "Accessibility rules"),
    componentDNA: boundedStringArray(genome.componentDNA, "Component DNA"),
    screenFamilies: boundedStringArray(genome.screenFamilies, "Screen families"),
    contentVoice: boundedStringArray(genome.contentVoice, "Content voice"),
    intentionalExceptions: boundedStringArray(genome.intentionalExceptions, "Intentional exceptions"),
    unconfirmedRules: boundedStringArray(genome.unconfirmedRules, "Unconfirmed rules"),
  };
}

export function genomePayloadHash(genomeInput: DesignGenome): string {
  const genome = parseGenome(genomeInput);
  const rules = { version: genome.version, productIdentity: genome.productIdentity, uxInvariants: genome.uxInvariants, visualInvariants: genome.visualInvariants, motionRules: genome.motionRules, accessibilityRules: genome.accessibilityRules, componentDNA: genome.componentDNA, screenFamilies: genome.screenFamilies, contentVoice: genome.contentVoice, intentionalExceptions: genome.intentionalExceptions, unconfirmedRules: genome.unconfirmedRules };
  return createHash("sha256").update(JSON.stringify(rules), "utf8").digest("hex");
}

function parseAuthority(value: unknown): GenomeAuthorityProof {
  const proof = objectValue(value, "Genome authority proof");
  exactKeys(proof, ["kind", "projectId", "rootFingerprint", "genomeEntityId", "genomeVersion", "approvedDraftRevision", "documentRevision", "payloadHash", "approvedBy", "approvedAt", "signature"], [], "Genome authority proof");
  if (proof.kind !== "GENOME_AUTHORITY" || proof.approvedBy !== "local-user") throw new Error("Genome authority actor or kind is invalid");
  return { kind: "GENOME_AUTHORITY", projectId: safeId(proof.projectId, "Authority project identity"), rootFingerprint: hash(proof.rootFingerprint, "Authority root fingerprint"), genomeEntityId: safeId(proof.genomeEntityId, "Authority Genome identity"), genomeVersion: boundedString(proof.genomeVersion, "Authority Genome version", MAX_SHORT_TEXT_LENGTH), approvedDraftRevision: positiveRevision(proof.approvedDraftRevision), documentRevision: positiveRevision(proof.documentRevision), payloadHash: hash(proof.payloadHash, "Authority payload hash"), approvedBy: "local-user", approvedAt: isoTimestamp(proof.approvedAt, "Authority approval time"), signature: hash(proof.signature, "Authority signature") };
}

function safeRoute(value: unknown): string {
  const route = boundedString(value, "Screen route", MAX_SHORT_TEXT_LENGTH);
  return normalizeGovernanceRoute(route);
}

function parseScreenRecord(value: unknown): ScreenRecord {
  const record = objectValue(value, "Screen record");
  exactKeys(record, ["id", "route", "name", "family", "inheritedRules", "exceptions", "requiredStates", "evidence", "driftStatus"], ["lastVerified"], "Screen record");
  if (!["NOT_VERIFIED", "PASS", "DRIFT", "INTENTIONAL"].includes(record.driftStatus as string)) throw new Error("Screen drift status is invalid");
  if (!Array.isArray(record.evidence) || record.evidence.length > MAX_RULES) throw new Error("Screen evidence must be a bounded array");
  const evidence = record.evidence.map((entry, index) => evidenceId(entry, `Screen evidence[${index}]`));
  if (new Set(evidence).size !== evidence.length) throw new Error("Screen evidence must be unique");
  const lastVerified = record.lastVerified === undefined ? undefined : isoTimestamp(record.lastVerified, "Last verification");
  if (record.driftStatus === "NOT_VERIFIED" && lastVerified !== undefined) throw new Error("A NOT_VERIFIED screen cannot claim a verification time");
  if (record.driftStatus !== "NOT_VERIFIED" && (lastVerified === undefined || evidence.length === 0)) throw new Error("A verified screen requires authenticated evidence and an ISO verification time");
  return { id: safeId(record.id, "Screen record identity"), route: safeRoute(record.route), name: boundedString(record.name, "Screen name", MAX_SHORT_TEXT_LENGTH), family: boundedString(record.family, "Screen family", MAX_SHORT_TEXT_LENGTH), inheritedRules: boundedStringArray(record.inheritedRules, "Inherited rules"), exceptions: boundedStringArray(record.exceptions, "Screen exceptions"), requiredStates: boundedStringArray(record.requiredStates, "Required states"), evidence, driftStatus: record.driftStatus as ScreenRecord["driftStatus"], ...(lastVerified === undefined ? {} : { lastVerified }) };
}

function decisionPayloadHash(decision: DesignDecision): string {
  const { approvedBy: _approvedBy, ...payload } = decision;
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function parseDesignDecision(value: unknown): DesignDecision {
  const decision = objectValue(value, "Design decision");
  exactKeys(decision, ["id", "date", "status", "scope", "decision", "reason", "alternatives", "affectedScreens", "affectedComponents", "migrationRequired", "genomeChanges"], ["approvedBy"], "Design decision");
  if (!["DRAFT", "APPROVED", "REJECTED"].includes(decision.status as string)) throw new Error("Design decision status is invalid");
  if (typeof decision.migrationRequired !== "boolean") throw new Error("Design decision migration flag must be boolean");
  const approvedBy = optionalBoundedString(decision.approvedBy, "Design decision approver", MAX_SHORT_TEXT_LENGTH);
  if (approvedBy !== undefined && approvedBy !== "local-user") throw new Error("Design decision approver must be local-user");
  return { id: safeId(decision.id, "Design decision identity"), date: isoTimestamp(decision.date, "Design decision date"), status: decision.status as DesignDecision["status"], scope: boundedString(decision.scope, "Design decision scope", MAX_SHORT_TEXT_LENGTH), decision: boundedString(decision.decision, "Design decision", 4_000), reason: boundedString(decision.reason, "Design decision reason", 4_000), alternatives: boundedStringArray(decision.alternatives, "Design decision alternatives"), affectedScreens: boundedStringArray(decision.affectedScreens, "Affected screens"), affectedComponents: boundedStringArray(decision.affectedComponents, "Affected components"), migrationRequired: decision.migrationRequired, genomeChanges: boundedStringArray(decision.genomeChanges, "Genome changes"), ...(approvedBy === undefined ? {} : { approvedBy }) };
}

function parseDecisionProof(value: unknown): DecisionApprovalProof {
  const proof = objectValue(value, "Design decision approval proof");
  exactKeys(proof, ["kind", "projectId", "rootFingerprint", "genomeEntityId", "decisionId", "decisionHash", "approvedBy", "approvedAt", "signature"], [], "Design decision approval proof");
  if (proof.kind !== "DESIGN_DECISION_APPROVAL" || proof.approvedBy !== "local-user") throw new Error("Design decision approval proof actor or kind is invalid");
  return { kind: "DESIGN_DECISION_APPROVAL", projectId: safeId(proof.projectId, "Decision proof project identity"), rootFingerprint: hash(proof.rootFingerprint, "Decision proof root fingerprint"), genomeEntityId: safeId(proof.genomeEntityId, "Decision proof Genome identity"), decisionId: safeId(proof.decisionId, "Decision proof identity"), decisionHash: hash(proof.decisionHash, "Decision proof hash"), approvedBy: "local-user", approvedAt: isoTimestamp(proof.approvedAt, "Decision approval time"), signature: hash(proof.signature, "Decision proof signature") };
}

function validateScreens(records: ScreenRecord[], context?: ScreenRelationContext): ScreenRecord[] {
  if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error("Screen Registry record identities must be unique");
  if (new Set(records.map((record) => record.route)).size !== records.length) throw new Error("Screen Registry routes must be unique");
  if (context !== undefined) {
    const evidenceIds = new Set(context.evidenceIds);
    const authenticatedVerificationEvidenceIds = new Set(
      context.authenticatedVerificationEvidenceIds ?? [],
    );
    const inherited = new Set([...context.genome.uxInvariants, ...context.genome.visualInvariants, ...context.genome.motionRules, ...context.genome.accessibilityRules, ...context.genome.componentDNA, ...context.genome.contentVoice]);
    const families = new Set([...context.genome.screenFamilies, "UNCONFIRMED"]);
    const exceptions = new Set(context.genome.intentionalExceptions);
    for (const record of records) {
      if (!families.has(record.family)) throw new Error("Screen family is not related to the same Genome");
      if (record.inheritedRules.some((rule) => !inherited.has(rule))) throw new Error("Screen inherited rules are not related to the same Genome");
      if (record.exceptions.some((rule) => !exceptions.has(rule))) throw new Error("Screen exceptions are not related to the same Genome");
      if (record.evidence.some((id) => !evidenceIds.has(id))) throw new Error("Screen verification evidence is not authenticated by this Registry");
      if (
        context.evidenceRoutes !== undefined &&
        record.evidence.some((id) => context.evidenceRoutes?.[id] !== record.route)
      ) throw new Error("Screen evidence route does not match the registered screen route");
      if (
        record.driftStatus !== "NOT_VERIFIED" &&
        !record.evidence.some((id) => authenticatedVerificationEvidenceIds.has(id))
      ) throw new Error("Screen coverage remains NOT_VERIFIED without authenticated verification evidence");
    }
  }
  return records;
}

function validateDecisions(
  decisions: DesignDecision[],
  proofs: DecisionApprovalProof[],
  screens?: readonly ScreenRecord[],
): DesignDecision[] {
  if (new Set(decisions.map((decision) => decision.id)).size !== decisions.length) throw new Error("Design Decision identities must be unique");
  if (new Set(proofs.map((proof) => proof.decisionId)).size !== proofs.length) throw new Error("Design Decision approval proofs must be unique");
  const proofById = new Map(proofs.map((proof) => [proof.decisionId, proof]));
  const registeredScreens = screens === undefined
    ? undefined
    : new Set(screens.flatMap((screen) => [screen.id, screen.route]));
  for (const decision of decisions) {
    const proof = proofById.get(decision.id);
    const consequential = decision.migrationRequired || decision.genomeChanges.length > 0;
    if (decision.status === "APPROVED") {
      if (decision.approvedBy !== "local-user" || proof === undefined || proof.decisionHash !== decisionPayloadHash(decision)) throw new Error("Approved Design Decision requires an exact local-user decision proof");
    } else if (decision.approvedBy !== undefined || proof !== undefined) throw new Error("A non-approved Design Decision cannot contain approval authority");
    if (consequential && decision.status !== "APPROVED") throw new Error("Migration and Genome changes require an approved local-user decision proof");
    if (
      registeredScreens !== undefined &&
      decision.affectedScreens.some((screen) => !registeredScreens.has(screen))
    ) throw new Error("Design Decision references an unregistered screen id or route");
  }
  if (proofs.some((proof) => !decisions.some((decision) => decision.id === proof.decisionId))) throw new Error("Design Decision approval proof has no matching decision");
  return decisions;
}

function parseDriftScopeEntries(value: unknown): DriftAuditScopeEntry[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) {
    throw new Error("Drift expected scope must be bounded");
  }
  const entries = value.map((entry) => {
    const record = objectValue(entry, "Drift expected scope entry");
    exactKeys(record, ["screen", "states"], [], "Drift expected scope entry");
    if (!Array.isArray(record.states) || record.states.length === 0 || record.states.length > MAX_RULES) {
      throw new Error("Drift expected states must be explicitly enumerated");
    }
    const states = record.states.map((state, index) => boundedString(
      state,
      `Drift expected state[${index}]`,
      MAX_SHORT_TEXT_LENGTH,
    ));
    if (new Set(states).size !== states.length) throw new Error("Drift expected states must be unique");
    return { screen: safeRoute(record.screen), states };
  });
  if (new Set(entries.map(({ screen }) => screen)).size !== entries.length) {
    throw new Error("Drift expected screen routes must be unique");
  }
  return entries;
}

function parseDriftFinding(value: unknown): DriftFinding {
  const finding = objectValue(value, "Drift finding");
  exactKeys(
    finding,
    ["category", "severity", "scope", "evidenceIds", "genomeRuleId", "expectedRule", "observedEvidence", "whyItMatters", "recommendedFix", "requiresDesignDecision", "status"],
    [],
    "Drift finding",
  );
  const categories = new Set([
    "UX_NAVIGATION",
    "ACCESSIBILITY_REQUIRED_STATES",
    "PRODUCT_IDENTITY_SCREEN_FAMILY",
    "COMPONENTS_TOKENS",
    "HIERARCHY",
    "MOTION",
    "POLISH",
  ]);
  const severities = new Set(["CRITICAL", "IMPORTANT", "POLISH", "INTENTIONAL"]);
  if (!categories.has(finding.category as string) || !severities.has(finding.severity as string)) {
    throw new Error("Drift finding category or severity is invalid");
  }
  if (!Array.isArray(finding.observedEvidence) || finding.observedEvidence.length === 0 || finding.observedEvidence.length > MAX_RULES) {
    throw new Error("Drift finding observed evidence must be bounded and non-empty");
  }
  if (!Array.isArray(finding.evidenceIds) || finding.evidenceIds.length === 0 || finding.evidenceIds.length > MAX_RULES) {
    throw new Error("Drift finding authenticated evidence must be bounded and non-empty");
  }
  if (typeof finding.requiresDesignDecision !== "boolean") {
    throw new Error("Drift finding decision requirement is invalid");
  }
  return {
    category: finding.category as DriftFinding["category"],
    severity: finding.severity as DriftFinding["severity"],
    scope: boundedString(finding.scope, "Drift finding scope", MAX_SHORT_TEXT_LENGTH),
    evidenceIds: finding.evidenceIds.map((entry, index) => evidenceId(entry, `Drift finding evidence[${index}]`)),
    genomeRuleId: safeId(finding.genomeRuleId, "Drift Genome rule identity"),
    expectedRule: boundedString(finding.expectedRule, "Drift expected rule"),
    observedEvidence: finding.observedEvidence.map((entry, index) => boundedString(
      entry,
      `Drift observed evidence[${index}]`,
    )),
    whyItMatters: boundedString(finding.whyItMatters, "Drift impact"),
    recommendedFix: boundedString(finding.recommendedFix, "Drift recommendation"),
    requiresDesignDecision: finding.requiresDesignDecision,
    status: boundedString(finding.status, "Drift finding status", MAX_SHORT_TEXT_LENGTH),
  };
}

function parseDriftReport(value: unknown): DriftReport {
  const report = objectValue(value, "Drift report");
  exactKeys(
    report,
    ["requestedScope", "expectedScope", "inspectedScope", "unavailableScope", "unverifiedScope", "evidenceIds", "findings", "overallStatus"],
    [],
    "Drift report",
  );
  if (report.requestedScope !== "WHOLE_APP" && report.requestedScope !== "SELECTED_SCREENS") {
    throw new Error("Drift requested scope is invalid");
  }
  const list = (entry: unknown, label: string): string[] => {
    if (!Array.isArray(entry) || entry.length > MAX_RECORDS) throw new Error(`${label} must be bounded`);
    const values = entry.map((item, index) => boundedString(item, `${label}[${index}]`));
    if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
    return values;
  };
  if (!Array.isArray(report.evidenceIds) || report.evidenceIds.length > MAX_RECORDS) {
    throw new Error("Drift report evidence must be bounded");
  }
  const evidenceIds = report.evidenceIds.map((entry, index) => evidenceId(entry, `Drift evidence[${index}]`));
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("Drift report evidence must be unique");
  if (!Array.isArray(report.findings) || report.findings.length > MAX_RECORDS) {
    throw new Error("Drift findings must be bounded");
  }
  const overallStatus = report.overallStatus;
  if (
    typeof overallStatus !== "string" ||
    !(["PASS", "PASS_WITH_DEBT", "NOT_VERIFIED", "BLOCKED"] as const).includes(
      overallStatus as "PASS" | "PASS_WITH_DEBT" | "NOT_VERIFIED" | "BLOCKED",
    )
  ) {
    throw new Error("Drift report status is invalid");
  }
  return {
    requestedScope: report.requestedScope,
    expectedScope: parseDriftScopeEntries(report.expectedScope),
    inspectedScope: list(report.inspectedScope, "Drift inspected scope"),
    unavailableScope: list(report.unavailableScope, "Drift unavailable scope"),
    unverifiedScope: list(report.unverifiedScope, "Drift unverified scope"),
    evidenceIds,
    findings: report.findings.map(parseDriftFinding),
    overallStatus: overallStatus as DriftReport["overallStatus"],
  };
}

export function parseGovernanceMetadata(markdown: string): GovernanceMetadata {
  const lineEnd = markdown.indexOf("\n");
  const firstLine = lineEnd === -1 ? markdown : markdown.slice(0, lineEnd);
  if (!firstLine.startsWith(GOVERNANCE_METADATA_PREFIX) || !firstLine.endsWith(GOVERNANCE_METADATA_SUFFIX)) throw new Error("Governance document metadata is missing");
  let parsed: unknown;
  try { parsed = JSON.parse(firstLine.slice(GOVERNANCE_METADATA_PREFIX.length, -GOVERNANCE_METADATA_SUFFIX.length)); } catch { throw new Error("Governance document metadata is malformed"); }
  const metadata = objectValue(parsed, "Governance metadata");
  let normalized: GovernanceMetadata;
  if (metadata.kind === "DESIGN_GENOME") {
    exactKeys(metadata, ["schemaVersion", "kind", "projectId", "entityId", "revision", "status", "inspectedScope", "claimCitations", "value"], ["authority"], "Design Genome metadata");
    assertBaseMetadata(metadata, "DESIGN_GENOME");
    const value = parseGenome(metadata.value);
    if (metadata.status !== value.status) throw new Error("Design Genome status metadata is inconsistent");
    const authority = metadata.authority === undefined ? undefined : parseAuthority(metadata.authority);
    const inspectedScope = parseInspectedScope(metadata.inspectedScope);
    if (!Array.isArray(metadata.claimCitations) || metadata.claimCitations.length > MAX_RECORDS) throw new Error("Genome claim citations must be bounded");
    const claimCitations = metadata.claimCitations.map(parseClaimCitation);
    const inspectedRoutes = new Set(inspectedScope.routes);
    const inspectedEvidence = new Set(inspectedScope.evidenceIds);
    if (claimCitations.some((citation) =>
      citation.scope.routes.some((route) => !inspectedRoutes.has(route)) ||
      citation.evidenceIds.some((id) => !inspectedEvidence.has(id)))) {
      throw new Error("Genome claim citations exceed the authenticated inspected scope");
    }
    if (value.status === "DRAFT" && authority !== undefined) throw new Error("Draft Genome cannot contain authority");
    if (value.status === "APPROVED" && authority === undefined) throw new Error("Approved Genome requires authenticated authority proof");
    if (authority !== undefined && (authority.projectId !== metadata.projectId || authority.genomeEntityId !== metadata.entityId || authority.genomeVersion !== value.version || authority.documentRevision !== metadata.revision || !isNextRevision(authority.approvedDraftRevision, metadata.revision as number) || authority.payloadHash !== genomePayloadHash(value))) throw new Error("Genome authority proof is stale or inconsistent");
    normalized = { schemaVersion: GOVERNANCE_SCHEMA_VERSION, kind: "DESIGN_GENOME", projectId: metadata.projectId as string, entityId: metadata.entityId as string, revision: metadata.revision as number, status: value.status, inspectedScope, claimCitations, ...(authority === undefined ? {} : { authority }), value };
  } else if (metadata.kind === "SCREEN_REGISTRY") {
    exactKeys(metadata, ["schemaVersion", "kind", "projectId", "entityId", "revision", "genomeEntityId", "genomeVersion", "genomeRevision", "evidenceIds", "records"], [], "Screen Registry metadata");
    assertBaseMetadata(metadata, "SCREEN_REGISTRY");
    if (!Array.isArray(metadata.evidenceIds) || metadata.evidenceIds.length > MAX_RECORDS) throw new Error("Registry evidence identifiers must be bounded");
    const evidenceIds = metadata.evidenceIds.map((entry, index) => evidenceId(entry, `Registry evidence[${index}]`));
    if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("Registry evidence identifiers must be unique");
    const records = assertScreenRecords(metadata.records);
    if (records.some((record) => record.evidence.some((id) => !evidenceIds.includes(id)))) throw new Error("Registry contains unauthenticated evidence");
    normalized = { schemaVersion: GOVERNANCE_SCHEMA_VERSION, kind: "SCREEN_REGISTRY", projectId: metadata.projectId as string, entityId: metadata.entityId as string, revision: metadata.revision as number, genomeEntityId: safeId(metadata.genomeEntityId, "Registry Genome identity"), genomeVersion: boundedString(metadata.genomeVersion, "Registry Genome version", MAX_SHORT_TEXT_LENGTH), genomeRevision: positiveRevision(metadata.genomeRevision), evidenceIds, records };
  } else if (metadata.kind === "DESIGN_DECISIONS") {
    exactKeys(metadata, ["schemaVersion", "kind", "projectId", "entityId", "revision", "genomeEntityId", "genomeVersion", "genomeRevision", "approvalProofs", "decisions"], [], "Design Decisions metadata");
    assertBaseMetadata(metadata, "DESIGN_DECISIONS");
    if (!Array.isArray(metadata.approvalProofs) || metadata.approvalProofs.length > MAX_RECORDS) throw new Error("Decision approval proofs must be bounded");
    const approvalProofs = metadata.approvalProofs.map(parseDecisionProof);
    const decisions = assertDesignDecisions(metadata.decisions, approvalProofs);
    normalized = { schemaVersion: GOVERNANCE_SCHEMA_VERSION, kind: "DESIGN_DECISIONS", projectId: metadata.projectId as string, entityId: metadata.entityId as string, revision: metadata.revision as number, genomeEntityId: safeId(metadata.genomeEntityId, "Decisions Genome identity"), genomeVersion: boundedString(metadata.genomeVersion, "Decisions Genome version", MAX_SHORT_TEXT_LENGTH), genomeRevision: positiveRevision(metadata.genomeRevision), approvalProofs, decisions };
  } else if (metadata.kind === "DRIFT_REPORT") {
    exactKeys(metadata, ["schemaVersion", "kind", "projectId", "entityId", "revision", "genomeEntityId", "genomeVersion", "genomeRevision", "registryEntityId", "registryRevision", "evidenceIds", "auditedAt", "value"], [], "Drift Report metadata");
    assertBaseMetadata(metadata, "DRIFT_REPORT");
    if (!Array.isArray(metadata.evidenceIds) || metadata.evidenceIds.length > MAX_RECORDS) {
      throw new Error("Drift Report evidence identifiers must be bounded");
    }
    const evidenceIds = metadata.evidenceIds.map((entry, index) => evidenceId(entry, `Drift Report evidence[${index}]`));
    if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("Drift Report evidence identifiers must be unique");
    const value = parseDriftReport(metadata.value);
    if (value.evidenceIds.length !== evidenceIds.length || value.evidenceIds.some((id) => !evidenceIds.includes(id))) {
      throw new Error("Drift Report value evidence does not match metadata evidence");
    }
    normalized = {
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      kind: "DRIFT_REPORT",
      projectId: metadata.projectId as string,
      entityId: metadata.entityId as string,
      revision: metadata.revision as number,
      genomeEntityId: safeId(metadata.genomeEntityId, "Drift Report Genome identity"),
      genomeVersion: boundedString(metadata.genomeVersion, "Drift Report Genome version", MAX_SHORT_TEXT_LENGTH),
      genomeRevision: positiveRevision(metadata.genomeRevision),
      registryEntityId: safeId(metadata.registryEntityId, "Drift Report Registry identity"),
      registryRevision: positiveRevision(metadata.registryRevision),
      evidenceIds,
      auditedAt: isoTimestamp(metadata.auditedAt, "Drift Report audit time"),
      value,
    };
  } else throw new Error("Governance document kind is invalid");
  const canonical = normalized.kind === "DESIGN_GENOME" ? renderGenome(normalized) : normalized.kind === "SCREEN_REGISTRY" ? renderScreenRegistry(normalized) : normalized.kind === "DESIGN_DECISIONS" ? renderDesignDecisions(normalized) : renderDriftReport(normalized);
  if (canonical !== markdown) throw new Error("Governance Markdown body or metadata is not canonical");
  return normalized;
}

export function assertGenome(value: unknown): DesignGenome { return parseGenome(value); }

export function assertScreenRecords(value: unknown, context?: ScreenRelationContext): ScreenRecord[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) throw new Error("Screen Registry records must be bounded");
  return validateScreens(value.map(parseScreenRecord), context);
}

export function assertDesignDecisions(
  value: unknown,
  proofs: DecisionApprovalProof[] = [],
  screens?: readonly ScreenRecord[],
): DesignDecision[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) throw new Error("Design Decisions must be bounded");
  return validateDecisions(value.map(parseDesignDecision), proofs, screens);
}
