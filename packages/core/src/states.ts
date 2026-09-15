import type {
  LearnSessionStatus,
  MangekyoStatus,
  ProjectStatus,
  SafeExecutionStatus
} from "./domain";

const projectTransitions = {
  UNINITIALIZED: ["SCANNING"],
  SCANNING: ["READY", "NEEDS_CONFIGURATION"],
  NEEDS_CONFIGURATION: ["READY"],
  READY: []
} as const satisfies Record<ProjectStatus, readonly ProjectStatus[]>;

const learnSessionTransitions = {
  DRAFT: ["ANALYZING"],
  ANALYZING: ["RESULT_READY"],
  RESULT_READY: ["AWAITING_DECISION"],
  AWAITING_DECISION: ["APPROVED", "REVISE", "REJECT"],
  APPROVED: [],
  REVISE: [],
  REJECT: []
} as const satisfies Record<LearnSessionStatus, readonly LearnSessionStatus[]>;

const safeExecutionTransitions = {
  IDLE: ["PREPARING"],
  PREPARING: ["PROPOSING", "FAILED"],
  PROPOSING: ["WAITING_APPROVAL"],
  WAITING_APPROVAL: ["APPROVED", "REVISING", "REJECTED"],
  APPROVED: ["EDITING"],
  REVISING: ["PROPOSING"],
  EDITING: ["RUNNING", "FAILED"],
  RUNNING: ["CAPTURING", "FAILED"],
  CAPTURING: ["VERIFYING", "FAILED"],
  VERIFYING: ["COMPLETE", "PROPOSING", "FAILED"],
  COMPLETE: [],
  REJECTED: [],
  FAILED: []
} as const satisfies Record<SafeExecutionStatus, readonly SafeExecutionStatus[]>;

const mangekyoTransitions = {
  IDLE: ["PREPARING"],
  PREPARING: ["POLICY_CHECK", "FAILED"],
  POLICY_CHECK: ["EDITING", "HUMAN_GATE", "FAILED"],
  EDITING: ["RUNNING", "FAILED"],
  RUNNING: ["CAPTURING", "FAILED"],
  CAPTURING: ["COMPARING", "FAILED"],
  COMPARING: ["DECIDING", "FAILED"],
  DECIDING: ["COMPLETE", "FIXING", "HUMAN_GATE"],
  FIXING: ["POLICY_CHECK", "FAILED"],
  HUMAN_GATE: ["POLICY_CHECK", "BLOCKED"],
  COMPLETE: [],
  BLOCKED: [],
  FAILED: []
} as const satisfies Record<MangekyoStatus, readonly MangekyoStatus[]>;

function canTransition<T extends string>(
  transitions: Record<T, readonly T[]>,
  from: T,
  to: T
): boolean {
  return transitions[from].includes(to);
}

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return canTransition(projectTransitions, from, to);
}

export function canTransitionLearnSession(
  from: LearnSessionStatus,
  to: LearnSessionStatus
): boolean {
  return canTransition(learnSessionTransitions, from, to);
}

export function canTransitionSafeExecution(
  from: SafeExecutionStatus,
  to: SafeExecutionStatus
): boolean {
  return canTransition(safeExecutionTransitions, from, to);
}

export function canTransitionMangekyo(from: MangekyoStatus, to: MangekyoStatus): boolean {
  return canTransition(mangekyoTransitions, from, to);
}
