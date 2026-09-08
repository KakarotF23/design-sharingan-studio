import type {
  DesignGenome,
  DriftAuditCategory,
  DriftAuditEvidence,
  DriftAuditScope,
  DriftAuditScopeEntry,
  DriftFinding,
  DriftReport,
  DriftSeverity,
  VisualFinding,
} from "@design-sharingan/core";
import { createHash } from "node:crypto";
import { normalizeGovernanceRoute } from "@design-sharingan/core";
import {
  isAuthenticatedGenomeDocument,
  type GenomeDocument,
} from "@design-sharingan/governance";

export const AUDIT_ORDER: readonly DriftAuditCategory[] = [
  "UX_NAVIGATION",
  "ACCESSIBILITY_REQUIRED_STATES",
  "PRODUCT_IDENTITY_SCREEN_FAMILY",
  "COMPONENTS_TOKENS",
  "HIERARCHY",
  "MOTION",
  "POLISH",
] as const;

export interface DriftObservation {
  category: DriftAuditCategory;
  severity: DriftSeverity;
  expectedRule: string;
  observedEvidence: string[];
  whyItMatters: string;
  recommendedFix: string;
  requiresDesignDecision?: boolean;
  repeatedAcrossScreens?: string[];
  status?: string;
}

export interface DriftAuditEvidenceInput extends DriftAuditEvidence {
  observations?: DriftObservation[];
}

export interface RunDriftAuditInput {
  requestedScope: DriftAuditScope;
  expectedScope?: DriftAuditScopeEntry[];
  evidence: DriftAuditEvidenceInput[];
  /** A Task 12-attested Genome document; raw Genome values are never authoritative. */
  approvedGenome?: GenomeDocument;
}

function text(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > 1_000) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

/**
 * Converts the persisted visual result that is paired with an authenticated
 * render catalog entry into an audit observation. The caller supplies the
 * approved invariant; unsupported or evidence-free findings cannot enter the
 * deterministic drift comparison.
 */
export function driftObservationFromAuthenticatedVisualFinding(
  finding: Pick<VisualFinding, "category" | "severity" | "evidence" | "reason" | "recommendedAction" | "status">,
  expectedRule: string,
): DriftObservation | undefined {
  if (
    finding.category !== "HIERARCHY" ||
    finding.severity !== "IMPORTANT" ||
    finding.evidence.length === 0
  ) return undefined;
  return {
    category: "HIERARCHY",
    severity: "IMPORTANT",
    expectedRule: text(expectedRule, "Expected rule"),
    observedEvidence: [...finding.evidence],
    whyItMatters: finding.reason,
    recommendedFix: finding.recommendedAction,
    status: finding.status,
  };
}

function scopeKey(screen: string, state: string): string {
  return `${canonicalScreen(screen, "Screen")}#${text(state, "State")}`;
}

function canonicalScreen(value: string, label: string): string {
  const screen = text(value, label);
  return screen.startsWith("/") ? normalizeGovernanceRoute(screen) : screen;
}

function approvedRules(genome: DesignGenome | undefined, category: DriftAuditCategory): string[] {
  if (genome === undefined) return [];
  switch (category) {
    case "UX_NAVIGATION": return genome.uxInvariants;
    case "ACCESSIBILITY_REQUIRED_STATES": return genome.accessibilityRules;
    case "PRODUCT_IDENTITY_SCREEN_FAMILY": return [genome.productIdentity, ...genome.screenFamilies];
    case "COMPONENTS_TOKENS": return [...genome.componentDNA, ...genome.visualInvariants];
    case "HIERARCHY": return genome.visualInvariants;
    case "MOTION": return genome.motionRules;
    case "POLISH": return genome.visualInvariants;
  }
}

function genomeRuleId(category: DriftAuditCategory, rule: string): string {
  return `genome-rule-${createHash("sha256").update(`${category}\0${rule}`, "utf8").digest("hex").slice(0, 24)}`;
}

function normalizeExpectedScope(
  expectedScope: readonly DriftAuditScopeEntry[] | undefined,
): DriftAuditScopeEntry[] {
  if (expectedScope === undefined) return [];
  const normalized = expectedScope.map(({ screen, states }) => {
    const canonical = canonicalScreen(screen, "Expected screen");
    if (!Array.isArray(states) || states.length === 0 || states.length > 64) {
      throw new Error("Expected screen states must be explicitly enumerated");
    }
    const uniqueStates = states.map((state) => text(state, "Expected state"));
    if (new Set(uniqueStates).size !== uniqueStates.length) {
      throw new Error("Expected screen states must be unique");
    }
    return { screen: canonical, states: uniqueStates };
  });
  if (normalized.length > 64 || new Set(normalized.map(({ screen }) => screen)).size !== normalized.length) {
    throw new Error("Expected audit screens must be unique and bounded");
  }
  return normalized;
}

function findingsFromEvidence(
  evidence: readonly DriftAuditEvidenceInput[],
  genome: DesignGenome | undefined,
  unverifiedScope: string[],
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const entry of evidence) {
    if (entry.status !== "INSPECTED") continue;
    for (const observation of entry.observations ?? []) {
      if (!AUDIT_ORDER.includes(observation.category)) {
        throw new Error("Drift observation category is invalid");
      }
      if (!(["CRITICAL", "IMPORTANT", "POLISH", "INTENTIONAL"] as const).includes(observation.severity)) {
        throw new Error("Drift observation severity is invalid");
      }
      const repeated = observation.repeatedAcrossScreens ?? [];
      if (repeated.length > 0 && repeated.length < 2) {
        throw new Error("Repeated drift must identify at least two screens");
      }
      if (!Array.isArray(observation.observedEvidence) || observation.observedEvidence.length === 0) {
        throw new Error("Drift observation requires non-empty observed evidence");
      }
      if ((entry.evidenceIds ?? []).length === 0) {
        throw new Error("Drift observation requires authenticated evidence identities");
      }
      const requiresDesignDecision = observation.requiresDesignDecision === true || repeated.length > 0;
      const expectedRule = text(observation.expectedRule, "Expected rule");
      if (!approvedRules(genome, observation.category).includes(expectedRule)) {
        unverifiedScope.push(`${observation.category}: Observation is not bound to an approved Genome rule.`);
      }
      findings.push({
        category: observation.category,
        severity: observation.severity,
        scope: entry.state === undefined ? entry.screen : scopeKey(entry.screen, entry.state),
        evidenceIds: [...new Set(entry.evidenceIds ?? [])],
        genomeRuleId: genomeRuleId(observation.category, expectedRule),
        expectedRule,
        observedEvidence: observation.observedEvidence.map((value) => text(value, "Observed evidence")),
        whyItMatters: text(observation.whyItMatters, "Drift impact"),
        recommendedFix: text(observation.recommendedFix, "Drift fix"),
        requiresDesignDecision,
        status: repeated.length > 0 ? "DECIDE" : (observation.status ?? "OPEN"),
      });
    }
  }
  return findings.sort((left, right) =>
    AUDIT_ORDER.indexOf(left.category) - AUDIT_ORDER.indexOf(right.category),
  );
}

function overallStatus(input: {
  unverifiedScope: readonly string[];
  findings: readonly DriftFinding[];
}): DriftReport["overallStatus"] {
  if (input.unverifiedScope.length > 0) return "NOT_VERIFIED";
  if (input.findings.some(({ severity }) => severity === "CRITICAL")) return "BLOCKED";
  if (input.findings.some(({ severity }) => severity === "IMPORTANT" || severity === "POLISH")) {
    return "PASS_WITH_DEBT";
  }
  return "PASS";
}

export async function runDriftAudit(input: RunDriftAuditInput): Promise<DriftReport> {
  const expectedScope = normalizeExpectedScope(input.expectedScope);
  const evidence = input.evidence.map((entry) => ({
    ...entry,
    screen: canonicalScreen(entry.screen, "Evidence screen"),
    ...(entry.state === undefined ? {} : { state: text(entry.state, "Evidence state") }),
    evidenceIds: [...new Set((entry.evidenceIds ?? []).map((id) => text(id, "Evidence identity")))],
  }));
  if (evidence.length > 512) throw new Error("Audit evidence must be bounded");

  const evidenceKeys = new Set<string>();
  for (const entry of evidence) {
    const key = entry.state === undefined ? entry.screen : scopeKey(entry.screen, entry.state);
    if (evidenceKeys.has(key)) throw new Error("Audit evidence cannot duplicate a screen state");
    evidenceKeys.add(key);
    if (!(["INSPECTED", "UNAVAILABLE", "OUT_OF_SCOPE"] as const).includes(entry.status)) {
      throw new Error("Audit evidence status is invalid");
    }
  }

  const inspectedScope = evidence
    .filter(({ status }) => status === "INSPECTED")
    .map((entry) => entry.state === undefined ? entry.screen : scopeKey(entry.screen, entry.state));
  const unavailableScope = evidence
    .filter(({ status }) => status === "UNAVAILABLE")
    .map((entry) => `${entry.state === undefined ? entry.screen : scopeKey(entry.screen, entry.state)}: ${entry.reason ?? "Evidence is unavailable."}`);
  const unverifiedScope = [...unavailableScope];
  const authoritativeGenome = input.approvedGenome !== undefined && isAuthenticatedGenomeDocument(input.approvedGenome)
    ? input.approvedGenome.value
    : undefined;
  if (authoritativeGenome === undefined) {
    unverifiedScope.unshift("Authoritative approved Genome attestation is unavailable.");
  }

  for (const entry of evidence.filter(({ status }) => status === "INSPECTED")) {
    const key = entry.state === undefined ? entry.screen : scopeKey(entry.screen, entry.state);
    if ((entry.evidenceIds ?? []).length === 0) {
      unverifiedScope.push(`${key}: Authenticated rendered evidence is missing.`);
    }
  }

  if (input.requestedScope === "WHOLE_APP" && expectedScope.length === 0) {
    unverifiedScope.unshift("Whole-product scope was not explicitly enumerated.");
  }
  if (input.requestedScope === "WHOLE_APP" && expectedScope.length < 2) {
    unverifiedScope.unshift("Whole-product scope requires more than one distinct canonical screen.");
  }
  const expectedStateKeys = new Set(expectedScope.flatMap(({ screen, states }) =>
    states.map((state) => scopeKey(screen, state)),
  ));
  const inspectedStateKeys = new Set(inspectedScope);
  for (const expected of expectedScope) {
    for (const state of expected.states) {
      const key = scopeKey(expected.screen, state);
      const matching = evidence.find((entry) => entry.state === state && entry.screen === expected.screen);
      if (matching?.status !== "INSPECTED" && !unverifiedScope.some((entry) => entry.startsWith(`${key}:`))) {
        unverifiedScope.push(`${key}: Evidence is not inspected.`);
      }
    }
  }
  for (const key of inspectedStateKeys) {
    if (!expectedStateKeys.has(key)) {
      unverifiedScope.push(`${key}: Evidence is outside the explicit expected state scope.`);
    }
  }
  for (const entry of evidence.filter(({ status }) => status === "UNAVAILABLE")) {
    const key = entry.state === undefined ? entry.screen : scopeKey(entry.screen, entry.state);
    if (!expectedStateKeys.has(key)) {
      unverifiedScope.push(`${key}: Evidence is outside the explicit expected state scope.`);
    }
  }
  for (const entry of evidence.filter(({ status }) => status === "OUT_OF_SCOPE")) {
    const key = entry.state === undefined ? entry.screen : scopeKey(entry.screen, entry.state);
    if (!expectedStateKeys.has(key)) {
      unverifiedScope.push(`${key}: Evidence is outside the explicit expected state scope.`);
    }
  }
  if (input.requestedScope === "WHOLE_APP") {
    const expectedScreens = new Set(expectedScope.map(({ screen }) => screen));
    const inspectedScreens = new Set(evidence.filter(({ status }) => status === "INSPECTED").map(({ screen }) => screen));
    if (
      expectedScreens.size !== inspectedScreens.size ||
      [...expectedScreens].some((screen) => !inspectedScreens.has(screen)) ||
      [...inspectedScreens].some((screen) => !expectedScreens.has(screen))
    ) unverifiedScope.unshift("Whole-product inspected screens do not exactly match the explicit expected screen set.");
  }

  for (const category of AUDIT_ORDER) {
    if (!evidence.some((entry) => (entry.observations ?? []).some((observation) => observation.category === category))) {
      unverifiedScope.push(`${category}: Deterministic analysis is unavailable.`);
    }
  }
  const findings = findingsFromEvidence(evidence, authoritativeGenome, unverifiedScope);
  const evidenceIds = [...new Set(evidence.flatMap(({ evidenceIds }) => evidenceIds ?? []))];
  return {
    requestedScope: input.requestedScope,
    expectedScope,
    inspectedScope,
    unavailableScope,
    unverifiedScope,
    evidenceIds,
    findings,
    overallStatus: overallStatus({ unverifiedScope, findings }),
  };
}
