import type {
  DesignGenome,
  DriftAuditCategory,
  DriftAuditEvidence,
  DriftAuditScope,
  DriftAuditScopeEntry,
  DriftFinding,
  DriftReport,
  DriftSeverity,
} from "@design-sharingan/core";

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
  approvedGenome?: DesignGenome;
}

function text(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > 1_000) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function scopeKey(screen: string, state: string): string {
  return `${text(screen, "Screen")}#${text(state, "State")}`;
}

function normalizeExpectedScope(
  expectedScope: readonly DriftAuditScopeEntry[] | undefined,
): DriftAuditScopeEntry[] {
  if (expectedScope === undefined) return [];
  const normalized = expectedScope.map(({ screen, states }) => {
    text(screen, "Expected screen");
    if (!Array.isArray(states) || states.length === 0 || states.length > 64) {
      throw new Error("Expected screen states must be explicitly enumerated");
    }
    const uniqueStates = states.map((state) => text(state, "Expected state"));
    if (new Set(uniqueStates).size !== uniqueStates.length) {
      throw new Error("Expected screen states must be unique");
    }
    return { screen, states: uniqueStates };
  });
  if (normalized.length > 64 || new Set(normalized.map(({ screen }) => screen)).size !== normalized.length) {
    throw new Error("Expected audit screens must be unique and bounded");
  }
  return normalized;
}

function findingsFromEvidence(evidence: readonly DriftAuditEvidenceInput[]): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const entry of evidence) {
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
      const requiresDesignDecision = observation.requiresDesignDecision === true || repeated.length > 0;
      findings.push({
        category: observation.category,
        severity: observation.severity,
        scope: entry.state === undefined ? entry.screen : scopeKey(entry.screen, entry.state),
        expectedRule: text(observation.expectedRule, "Expected rule"),
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
    screen: text(entry.screen, "Evidence screen"),
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

  if (input.requestedScope === "WHOLE_APP" && expectedScope.length === 0) {
    unverifiedScope.unshift("Whole-product scope was not explicitly enumerated.");
  }
  for (const expected of expectedScope) {
    for (const state of expected.states) {
      const key = scopeKey(expected.screen, state);
      const matching = evidence.find((entry) => entry.state === state && entry.screen === expected.screen);
      if (matching?.status !== "INSPECTED" && !unverifiedScope.some((entry) => entry.startsWith(`${key}:`))) {
        unverifiedScope.push(`${key}: Evidence is not inspected.`);
      }
    }
  }
  if (input.requestedScope === "WHOLE_APP" && evidence.length === 1) {
    unverifiedScope.unshift("Whole-product scope cannot be established from one inspected screen.");
  }

  const findings = findingsFromEvidence(evidence);
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
