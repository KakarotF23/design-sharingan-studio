import type {
  ReleaseGate,
  ReleaseGateCheck,
  ReleaseGateCheckName,
  ReleaseGateStatus,
  ReleaseCheckStatus,
} from "@design-sharingan/core";
import { normalizeGovernanceRoute } from "@design-sharingan/core";

const CHECK_NAMES: readonly ReleaseGateCheckName[] = [
  "navigation",
  "accessibility",
  "criticalDrift",
  "newDesignRules",
  "screenRegistration",
  "requiredStates",
  "freshRenders",
  "decisions",
  "functionalVerification",
] as const;

export interface ReleaseCheckEvidence {
  evidence: string[];
  lastVerified?: string;
  blockingReason?: string;
}

export interface AuthenticatedReleaseEvidence {
  id: string;
  projectId: string;
  route: string;
  state: string;
  kind: "RENDER" | "EVIDENCE";
  capturedAt: string;
  sourceRevisionFingerprint: string;
  findingCategory?: "POLISH";
}

export interface ReleaseScopeEvidence {
  requestedScope: "WHOLE_APP" | "SELECTED_SCREENS";
  expectedScope: { screen: string; states: string[] }[];
  inspectedScope: string[];
  unavailableScope: string[];
}

export interface ReleasePolishDebt {
  finding: string;
  rationale: string;
  documentedBy: string;
  evidenceIds: string[];
}

/** Server-derived unresolved findings. Callers cannot use debt to hide one of these. */
export interface AuthenticatedUnresolvedFinding {
  finding: string;
  severity: "CRITICAL" | "IMPORTANT" | "POLISH" | "INTENTIONAL";
  evidenceIds: string[];
}

export interface EvaluateReleaseGateInput {
  scope?: ReleaseScopeEvidence;
  navigation: ReleaseCheckStatus;
  accessibility: ReleaseCheckStatus;
  criticalDrift: ReleaseCheckStatus;
  newDesignRules: ReleaseCheckStatus;
  screenRegistration: ReleaseCheckStatus;
  requiredStates: ReleaseCheckStatus;
  freshRenders: ReleaseCheckStatus;
  decisions: ReleaseCheckStatus;
  functionalVerification: ReleaseCheckStatus;
  evidence?: Partial<Record<ReleaseGateCheckName, ReleaseCheckEvidence>>;
  polishDebt?: ReleasePolishDebt[];
  authenticatedEvidence?: AuthenticatedReleaseEvidence[];
  approvedDecisionIds?: string[];
  currentSourceRevisionFingerprint?: string;
  projectId?: string;
  unresolvedFindings?: AuthenticatedUnresolvedFinding[];
}

function exactIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

export interface ReleaseGateResult extends ReleaseGate {
  nonBlockingDebt: ReleasePolishDebt[];
}

function scopeComplete(scope: ReleaseScopeEvidence | undefined): boolean {
  if (scope === undefined || scope.expectedScope.length === 0 || scope.unavailableScope.length > 0) {
    return false;
  }
  const normalizedScopeKey = (route: string, state: string): string | undefined => {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(state)) return undefined;
    try { return `${normalizeGovernanceRoute(route)}#${state}`; } catch { return undefined; }
  };
  const expected = new Set<string>();
  for (const { screen, states } of scope.expectedScope) {
    if (states.length === 0) return false;
    for (const state of states) {
      const key = normalizedScopeKey(screen, state);
      if (key === undefined || expected.has(key)) return false;
      expected.add(key);
    }
  }
  const inspected = new Set<string>();
  for (const raw of scope.inspectedScope) {
    const split = raw.lastIndexOf("#");
    const key = split <= 0 ? undefined : normalizedScopeKey(raw.slice(0, split), raw.slice(split + 1));
    if (key === undefined || inspected.has(key)) return false;
    inspected.add(key);
  }
  const expectedScreens = new Set([...expected].map((key) => key.slice(0, key.lastIndexOf("#"))));
  const inspectedScreens = new Set([...inspected].map((key) => key.slice(0, key.lastIndexOf("#"))));
  if (scope.requestedScope === "WHOLE_APP" && expectedScreens.size < 2) return false;
  return expected.size === inspected.size &&
    [...expected].every((key) => inspected.has(key)) &&
    expectedScreens.size === inspectedScreens.size &&
    [...expectedScreens].every((screen) => inspectedScreens.has(screen));
}

function evidenceFor(
  name: ReleaseGateCheckName,
  status: ReleaseCheckStatus,
  input: EvaluateReleaseGateInput,
): ReleaseGateCheck {
  const supplied = input.evidence?.[name];
  const evidence = [...new Set(supplied?.evidence ?? [])];
  const needsEvidence = status === "PASS" || status === "PASS_WITH_DEBT";
  const validVerifiedAt = exactIso(supplied?.lastVerified);
  const catalog = new Map((input.authenticatedEvidence ?? []).map((entry) => [entry.id, entry]));
  const expectedRoutes = new Set(input.scope?.expectedScope.map(({ screen }) => screen) ?? []);
  const catalogBound = evidence.length > 0 && evidence.every((id) => {
    const entry = catalog.get(id);
    if (
      entry === undefined || entry.projectId !== input.projectId ||
      !expectedRoutes.has(entry.route) || !exactIso(entry.capturedAt) ||
      entry.capturedAt !== supplied?.lastVerified
    ) return false;
    if (name === "requiredStates" || name === "freshRenders") {
      return entry.kind === "RENDER" &&
        entry.sourceRevisionFingerprint === input.currentSourceRevisionFingerprint;
    }
    return true;
  });
  const missingEvidence = needsEvidence && (evidence.length === 0 || !validVerifiedAt || !catalogBound);
  const staleReason = name === "freshRenders"
    ? "Fresh render evidence is required after the final UI/source change."
    : `${name} has no current evidence.`;
  return {
    name,
    status: missingEvidence ? "NOT_VERIFIED" : status,
    evidence,
    ...(supplied?.lastVerified === undefined ? {} : { lastVerified: supplied.lastVerified }),
    ...(supplied?.blockingReason === undefined
      ? (missingEvidence || status === "FAIL" ? { blockingReason: staleReason } : {})
      : { blockingReason: supplied.blockingReason }),
  };
}

function finalStatus(
  checks: readonly ReleaseGateCheck[],
  scope: ReleaseScopeEvidence | undefined,
  debt: readonly ReleasePolishDebt[],
): ReleaseGateStatus {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const blockedChecks: ReleaseGateCheckName[] = [
    "navigation",
    "accessibility",
    "criticalDrift",
    "newDesignRules",
    "functionalVerification",
  ];
  if (checks.some((check) => check.status === "BLOCKED") || blockedChecks.some((name) => byName.get(name)?.status === "FAIL")) {
    return "BLOCKED";
  }
  if (!scopeComplete(scope) || checks.some((check) => check.status !== "PASS")) {
    return "NOT_VERIFIED";
  }
  if (debt.length > 0 || checks.some((check) => check.status === "PASS_WITH_DEBT")) {
    return "PASS_WITH_DEBT";
  }
  return "PASS";
}

export function evaluateReleaseGate(input: EvaluateReleaseGateInput): ReleaseGateResult {
  const checks = CHECK_NAMES.map((name) => evidenceFor(name, input[name], input));
  const debt = (input.polishDebt ?? []).map((item) => ({ ...item }));
  const catalog = new Map((input.authenticatedEvidence ?? []).map((entry) => [entry.id, entry]));
  const decisions = new Set(input.approvedDecisionIds ?? []);
  const unresolved = input.unresolvedFindings ?? [];
  const solePolishDebt = debt.length === 0 || (
    unresolved.length === debt.length &&
    unresolved.every((finding) =>
      finding.severity === "POLISH" && finding.evidenceIds.length > 0 &&
      finding.evidenceIds.every((id) => catalog.get(id)?.findingCategory === "POLISH") &&
      debt.some((item) =>
        item.finding === finding.finding && item.evidenceIds.length === finding.evidenceIds.length &&
        item.evidenceIds.every((id) => finding.evidenceIds.includes(id)),
      ),
    )
  );
  if (debt.some((item) =>
    !item.finding.trim() || !item.rationale.trim() || !item.documentedBy.trim() ||
    item.evidenceIds.length === 0 || !decisions.has(item.documentedBy) ||
    item.evidenceIds.some((id) => catalog.get(id)?.findingCategory !== "POLISH")
  ) || !solePolishDebt) {
    throw new Error("Non-blocking polish debt must be the sole catalog-bound POLISH finding with a documented decision");
  }
  const status = finalStatus(checks, input.scope, debt);
  return {
    scope: input.scope?.requestedScope ?? "UNENUMERATED",
    checks,
    navigation: checks[0]!.status,
    accessibility: checks[1]!.status,
    criticalDrift: checks[2]!.status,
    newDesignRules: checks[3]!.status,
    screenRegistration: checks[4]!.status,
    requiredStates: checks[5]!.status,
    freshRenders: checks[6]!.status,
    decisions: checks[7]!.status,
    functionalVerification: checks[8]!.status,
    status,
    nonBlockingDebt: debt,
  };
}
