import type {
  ReleaseGate,
  ReleaseGateCheck,
  ReleaseGateCheckName,
  ReleaseGateStatus,
  ReleaseCheckStatus,
} from "@design-sharingan/core";

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
}

export interface ReleaseGateResult extends ReleaseGate {
  nonBlockingDebt: ReleasePolishDebt[];
}

function scopeComplete(scope: ReleaseScopeEvidence | undefined): boolean {
  if (scope === undefined || scope.expectedScope.length === 0 || scope.unavailableScope.length > 0) {
    return false;
  }
  if (scope.requestedScope === "WHOLE_APP" && scope.expectedScope.length < 2) {
    return false;
  }
  const inspected = new Set(scope.inspectedScope);
  return scope.expectedScope.every(({ screen, states }) =>
    states.length > 0 && states.every((state) => inspected.has(`${screen}#${state}`)),
  );
}

function evidenceFor(
  name: ReleaseGateCheckName,
  status: ReleaseCheckStatus,
  input: EvaluateReleaseGateInput,
): ReleaseGateCheck {
  const supplied = input.evidence?.[name];
  const evidence = [...new Set(supplied?.evidence ?? [])];
  const needsEvidence = status === "PASS" || status === "PASS_WITH_DEBT";
  const missingEvidence = needsEvidence && (evidence.length === 0 || supplied?.lastVerified === undefined);
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
  if (!scopeComplete(scope) || checks.some((check) => check.status === "FAIL" || check.status === "NOT_VERIFIED")) {
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
  if (debt.some((item) => !item.finding.trim() || !item.rationale.trim() || !item.documentedBy.trim())) {
    throw new Error("Non-blocking polish debt must reference a documented decision");
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
