import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { DesignDecision, DesignGenome, ScreenRecord } from "@design-sharingan/core";

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

export type GovernanceMetadata = GenomeMetadata | ScreenRegistryMetadata | DesignDecisionsMetadata;

export interface ScreenRelationContext {
  genome: DesignGenome;
  evidenceIds: readonly string[];
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

This document is human-readable product knowledge. A DRAFT Genome remains non-authoritative until a local user explicitly approves its exact revision and rule payload.

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
  let decoded: string;
  try { decoded = decodeURIComponent(route); } catch { throw new Error("Screen route must be a safe normalized route"); }
  if (!route.startsWith("/") || decoded.includes("\\") || route.includes("?") || route.includes("#") || /[\u0000-\u001f\u007f]/.test(decoded) || decoded.includes("//") || posix.normalize(decoded) !== decoded || /(^|\/)\.\.?($|\/)/.test(decoded)) throw new Error("Screen route must be a safe normalized route");
  return route;
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
  return { id: safeId(record.id, "Screen record identity"), route: safeRoute(record.route), name: boundedString(record.name, "Screen name", MAX_SHORT_TEXT_LENGTH), family: boundedString(record.family, "Screen family", MAX_SHORT_TEXT_LENGTH), inheritedRules: boundedStringArray(record.inheritedRules, "Inherited rules"), exceptions: boundedStringArray(record.exceptions, "Screen exceptions"), requiredStates: boundedStringArray(record.requiredStates, "Required states"), evidence, driftStatus: record.driftStatus as string, ...(lastVerified === undefined ? {} : { lastVerified }) };
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
  return { id: safeId(decision.id, "Design decision identity"), date: isoTimestamp(decision.date, "Design decision date"), status: decision.status as string, scope: boundedString(decision.scope, "Design decision scope", MAX_SHORT_TEXT_LENGTH), decision: boundedString(decision.decision, "Design decision", 4_000), reason: boundedString(decision.reason, "Design decision reason", 4_000), alternatives: boundedStringArray(decision.alternatives, "Design decision alternatives"), affectedScreens: boundedStringArray(decision.affectedScreens, "Affected screens"), affectedComponents: boundedStringArray(decision.affectedComponents, "Affected components"), migrationRequired: decision.migrationRequired, genomeChanges: boundedStringArray(decision.genomeChanges, "Genome changes"), approvedBy: optionalBoundedString(decision.approvedBy, "Design decision approver", MAX_SHORT_TEXT_LENGTH) };
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
        record.driftStatus !== "NOT_VERIFIED" &&
        !record.evidence.some((id) => authenticatedVerificationEvidenceIds.has(id))
      ) throw new Error("Screen coverage remains NOT_VERIFIED without authenticated verification evidence");
    }
  }
  return records;
}

function validateDecisions(decisions: DesignDecision[], proofs: DecisionApprovalProof[]): DesignDecision[] {
  if (new Set(decisions.map((decision) => decision.id)).size !== decisions.length) throw new Error("Design Decision identities must be unique");
  if (new Set(proofs.map((proof) => proof.decisionId)).size !== proofs.length) throw new Error("Design Decision approval proofs must be unique");
  const proofById = new Map(proofs.map((proof) => [proof.decisionId, proof]));
  for (const decision of decisions) {
    const proof = proofById.get(decision.id);
    const consequential = decision.migrationRequired || decision.genomeChanges.length > 0;
    if (decision.status === "APPROVED") {
      if (decision.approvedBy !== "local-user" || proof === undefined || proof.decisionHash !== decisionPayloadHash(decision)) throw new Error("Approved Design Decision requires an exact local-user decision proof");
    } else if (decision.approvedBy !== undefined || proof !== undefined) throw new Error("A non-approved Design Decision cannot contain approval authority");
    if (consequential && decision.status !== "APPROVED") throw new Error("Migration and Genome changes require an approved local-user decision proof");
  }
  if (proofs.some((proof) => !decisions.some((decision) => decision.id === proof.decisionId))) throw new Error("Design Decision approval proof has no matching decision");
  return decisions;
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
    exactKeys(metadata, ["schemaVersion", "kind", "projectId", "entityId", "revision", "status", "value"], ["authority"], "Design Genome metadata");
    assertBaseMetadata(metadata, "DESIGN_GENOME");
    const value = parseGenome(metadata.value);
    if (metadata.status !== value.status) throw new Error("Design Genome status metadata is inconsistent");
    const authority = metadata.authority === undefined ? undefined : parseAuthority(metadata.authority);
    if (value.status === "DRAFT" && authority !== undefined) throw new Error("Draft Genome cannot contain authority");
    if (value.status === "APPROVED" && authority === undefined) throw new Error("Approved Genome requires authenticated authority proof");
    if (authority !== undefined && (authority.projectId !== metadata.projectId || authority.genomeEntityId !== metadata.entityId || authority.genomeVersion !== value.version || authority.documentRevision !== metadata.revision || authority.approvedDraftRevision + 1 !== metadata.revision || authority.payloadHash !== genomePayloadHash(value))) throw new Error("Genome authority proof is stale or inconsistent");
    normalized = { schemaVersion: GOVERNANCE_SCHEMA_VERSION, kind: "DESIGN_GENOME", projectId: metadata.projectId as string, entityId: metadata.entityId as string, revision: metadata.revision as number, status: value.status, ...(authority === undefined ? {} : { authority }), value };
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
  } else throw new Error("Governance document kind is invalid");
  const canonical = normalized.kind === "DESIGN_GENOME" ? renderGenome(normalized) : normalized.kind === "SCREEN_REGISTRY" ? renderScreenRegistry(normalized) : renderDesignDecisions(normalized);
  if (canonical !== markdown) throw new Error("Governance Markdown body or metadata is not canonical");
  return normalized;
}

export function assertGenome(value: unknown): DesignGenome { return parseGenome(value); }

export function assertScreenRecords(value: unknown, context?: ScreenRelationContext): ScreenRecord[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) throw new Error("Screen Registry records must be bounded");
  return validateScreens(value.map(parseScreenRecord), context);
}

export function assertDesignDecisions(value: unknown, proofs: DecisionApprovalProof[] = []): DesignDecision[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) throw new Error("Design Decisions must be bounded");
  return validateDecisions(value.map(parseDesignDecision), proofs);
}
