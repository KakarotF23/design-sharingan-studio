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

interface CanonicalReleaseScope {
  expectedPairs: Set<string>;
  expectedRoutes: Set<string>;
  inspectedPairs: Set<string>;
}

function scopeComplete(scope: ReleaseScopeEvidence | undefined): boolean {
  if (scope === undefined || scope.expectedScope.length === 0 || scope.unavailableScope.length > 0) {
    return false;
  }
  const canonical = canonicalScope(scope);
  if (canonical === undefined) return false;
  if (scope.requestedScope === "WHOLE_APP" && canonical.expectedRoutes.size < 2) return false;
  return canonical.expectedPairs.size === canonical.inspectedPairs.size &&
    [...canonical.expectedPairs].every((key) => canonical.inspectedPairs.has(key));
}

function canonicalScopeKey(route: string, state: string): string | undefined {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(state)) return undefined;
  try { return `${normalizeGovernanceRoute(route)}#${state}`; } catch { return undefined; }
}

function canonicalScope(scope: ReleaseScopeEvidence): CanonicalReleaseScope | undefined {
  const expected = new Set<string>();
  for (const { screen, states } of scope.expectedScope) {
    if (states.length === 0) return undefined;
    for (const state of states) {
      const key = canonicalScopeKey(screen, state);
      if (key === undefined || expected.has(key)) return undefined;
      expected.add(key);
    }
  }
  const inspected = new Set<string>();
  for (const raw of scope.inspectedScope) {
    const split = raw.lastIndexOf("#");
    const key = split <= 0 ? undefined : canonicalScopeKey(raw.slice(0, split), raw.slice(split + 1));
    if (key === undefined || inspected.has(key)) return undefined;
    inspected.add(key);
  }
  return {
    expectedPairs: expected,
    expectedRoutes: new Set([...expected].map((key) => key.slice(0, key.lastIndexOf("#")))),
    inspectedPairs: inspected,
  };
}

function evidenceFor(
  name: ReleaseGateCheckName,
  status: ReleaseCheckStatus,
  input: EvaluateReleaseGateInput,
): ReleaseGateCheck {
  const supplied = input.evidence?.[name];
  const suppliedEvidence = supplied?.evidence ?? [];
  const evidence = [...new Set(suppliedEvidence)];
  const needsEvidence = status === "PASS" || status === "PASS_WITH_DEBT";
  const validVerifiedAt = exactIso(supplied?.lastVerified);
  const catalogEntries = input.authenticatedEvidence ?? [];
  const catalog = new Map(catalogEntries.map((entry) => [entry.id, entry]));
  const scope = input.scope === undefined ? undefined : canonicalScope(input.scope);
  const expectedRoutes = scope?.expectedRoutes ?? new Set<string>();
  const duplicateEvidence = evidence.length !== suppliedEvidence.length || catalog.size !== catalogEntries.length;
  const catalogBound = evidence.length > 0 && evidence.every((id) => {
    const entry = catalog.get(id);
    let canonicalRoute: string | undefined;
    try { canonicalRoute = entry === undefined ? undefined : normalizeGovernanceRoute(entry.route); } catch { return false; }
    if (
      entry === undefined || entry.projectId !== input.projectId ||
      canonicalRoute === undefined || !expectedRoutes.has(canonicalRoute) || !exactIso(entry.capturedAt) ||
      entry.capturedAt !== supplied?.lastVerified
    ) return false;
    if (name === "requiredStates" || name === "freshRenders") {
      return entry.kind === "RENDER" &&
        entry.sourceRevisionFingerprint === input.currentSourceRevisionFingerprint;
    }
    return true;
  });
  const fullStateRenderCoverage = (name === "requiredStates" || name === "freshRenders") && scope !== undefined &&
    evidence.length === scope.expectedPairs.size && evidence.length > 0 && (() => {
      const renderedPairs = new Set<string>();
      for (const id of evidence) {
        const entry = catalog.get(id);
        const key = entry === undefined ? undefined : canonicalScopeKey(entry.route, entry.state);
        if (
          entry === undefined || key === undefined || renderedPairs.has(key) ||
          entry.kind !== "RENDER" || entry.projectId !== input.projectId ||
          !exactIso(entry.capturedAt) || entry.capturedAt !== supplied?.lastVerified ||
          entry.sourceRevisionFingerprint !== input.currentSourceRevisionFingerprint
        ) return false;
        renderedPairs.add(key);
      }
      return renderedPairs.size === scope.expectedPairs.size &&
        [...scope.expectedPairs].every((key) => renderedPairs.has(key));
    })();
  const missingEvidence = needsEvidence && (
    evidence.length === 0 || duplicateEvidence || !validVerifiedAt || !catalogBound ||
    ((name === "requiredStates" || name === "freshRenders") && !fullStateRenderCoverage)
  );
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
  unresolved: readonly AuthenticatedUnresolvedFinding[],
): ReleaseGateStatus {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const blockedChecks: ReleaseGateCheckName[] = [
    "navigation",
    "accessibility",
    "criticalDrift",
    "newDesignRules",
    "functionalVerification",
  ];
  if (
    unresolved.some((finding) => finding.severity === "CRITICAL") ||
    checks.some((check) => check.status === "BLOCKED") ||
    blockedChecks.some((name) => byName.get(name)?.status === "FAIL")
  ) {
    return "BLOCKED";
  }
  if (
    !scopeComplete(scope) || checks.some((check) => check.status !== "PASS") ||
    (unresolved.length > 0 && debt.length === 0)
  ) {
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
  const status = finalStatus(checks, input.scope, debt, unresolved);
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
