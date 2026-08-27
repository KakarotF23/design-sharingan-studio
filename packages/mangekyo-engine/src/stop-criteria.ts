export interface StopCriteriaInput {
  round: number;
  maxRounds: number;
  criticalCount: number;
  importantCount: number;
  importantThreshold: number;
  uxRegressions: number;
  genomeConflicts: number;
  hasFreshFinalRender: boolean;
  buildFailed?: boolean;
  userStopped?: boolean;
  humanGatePending?: boolean;
  claimedScreens?: readonly string[];
  inspectedScreens?: readonly string[];
}

export type StopCriteriaOutcome =
  | "COMPLETE"
  | "MAX_ROUNDS"
  | "USER_STOPPED"
  | "BUILD_FAILED"
  | "HUMAN_GATE"
  | "CONTINUE";

export interface StopCriteriaResult {
  stop: boolean;
  pass: boolean;
  outcome: StopCriteriaOutcome;
  reason: string;
}

export function evaluateStopCriteria(input: StopCriteriaInput): StopCriteriaResult {
  if (input.buildFailed) {
    return {
      stop: true,
      pass: false,
      outcome: "BUILD_FAILED",
      reason: "A critical build failure stopped the visual loop."
    };
  }
  if (input.userStopped) {
    return {
      stop: true,
      pass: false,
      outcome: "USER_STOPPED",
      reason: "The user stopped the visual loop before completion."
    };
  }
  if (input.humanGatePending) {
    return {
      stop: true,
      pass: false,
      outcome: "HUMAN_GATE",
      reason: "A policy boundary requires a human decision."
    };
  }

  const claimedScreens = new Set(input.claimedScreens ?? []);
  const inspectedScreens = new Set(input.inspectedScreens ?? []);
  const scopeCovered =
    claimedScreens.size === 0 ||
    [...claimedScreens].every((screen) => inspectedScreens.has(screen));
  const meetsQualityCriteria =
    input.hasFreshFinalRender &&
    scopeCovered &&
    input.criticalCount === 0 &&
    input.importantCount <= input.importantThreshold &&
    input.uxRegressions === 0 &&
    input.genomeConflicts === 0;

  if (meetsQualityCriteria) {
    return {
      stop: true,
      pass: true,
      outcome: "COMPLETE",
      reason: "Quality criteria satisfied with fresh final evidence."
    };
  }
  if (input.round >= input.maxRounds) {
    return {
      stop: true,
      pass: false,
      outcome: "MAX_ROUNDS",
      reason: "Maximum visual round budget reached before quality criteria passed."
    };
  }
  if (!input.hasFreshFinalRender) {
    return {
      stop: false,
      pass: false,
      outcome: "CONTINUE",
      reason: "A fresh render is required after the final change."
    };
  }
  if (!scopeCovered) {
    return {
      stop: false,
      pass: false,
      outcome: "CONTINUE",
      reason: "The claimed screen scope has not been fully inspected."
    };
  }
  return {
    stop: false,
    pass: false,
    outcome: "CONTINUE",
    reason: "Visual quality criteria are not yet satisfied."
  };
}
