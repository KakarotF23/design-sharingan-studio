import type {
  AutonomyChange,
  AutonomyPolicy,
  AutonomyPolicyEvaluation,
} from "./policy";

export type ISODateTime = string;

export type ProjectStatus =
  | "UNINITIALIZED"
  | "SCANNING"
  | "NEEDS_CONFIGURATION"
  | "READY";

export type ReferenceStatus =
  | "UPLOADED"
  | "PROCESSING"
  | "READY"
  | "ANALYZED"
  | "ASSIMILATED";

export type LearnSessionStatus =
  | "DRAFT"
  | "ANALYZING"
  | "RESULT_READY"
  | "AWAITING_DECISION"
  | "APPROVED"
  | "REVISE"
  | "REJECT";

export type SafeExecutionStatus =
  | "IDLE"
  | "PREPARING"
  | "PROPOSING"
  | "WAITING_APPROVAL"
  | "APPROVED"
  | "REVISING"
  | "EDITING"
  | "RUNNING"
  | "CAPTURING"
  | "VERIFYING"
  | "COMPLETE"
  | "REJECTED"
  | "FAILED";

export type MangekyoStatus =
  | "IDLE"
  | "PREPARING"
  | "POLICY_CHECK"
  | "EDITING"
  | "RUNNING"
  | "CAPTURING"
  | "COMPARING"
  | "DECIDING"
  | "FIXING"
  | "HUMAN_GATE"
  | "COMPLETE"
  | "BLOCKED"
  | "FAILED";

export type FindingSeverity = "CRITICAL" | "IMPORTANT" | "POLISH" | "IGNORE";
export type DriftSeverity = Exclude<FindingSeverity, "IGNORE"> | "INTENTIONAL";
export type FindingCategory =
  | "HIERARCHY"
  | "TYPOGRAPHY"
  | "SPACING"
  | "LAYOUT"
  | "DENSITY"
  | "COMPONENT"
  | "COLOR"
  | "MOTION"
  | "ACCESSIBILITY"
  | "RESPONSIVE"
  | "GENOME";
export type ReleaseGateStatus = "PASS" | "PASS_WITH_DEBT" | "NOT_VERIFIED" | "BLOCKED";
export type ReleaseCheckStatus = "PASS" | "PASS_WITH_DEBT" | "FAIL" | "NOT_VERIFIED" | "BLOCKED";
export type DesignSessionType =
  | "REFERENCE_SCAN"
  | "ASSIMILATION"
  | "FEATURE_EVOLVE"
  | "SAFE_EXECUTION"
  | "MANGEKYO_LOOP"
  | "GENOME_INIT"
  | "DRIFT_AUDIT"
  | "RELEASE_GATE";

export interface Project {
  id: string;
  name: string;
  sourceType: "LOCAL" | "GITHUB";
  rootPath: string;
  repositoryUrl?: string;
  branch?: string;
  framework?: string;
  packageManager?: string;
  devCommand?: string;
  status: ProjectStatus;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ProjectCapability {
  canReadFiles: boolean;
  canWriteFiles: boolean;
  canRun: boolean;
  canRender: boolean;
  canCapture: boolean;
  canUseGit: boolean;
  canAudit: boolean;
}

export interface Reference {
  id: string;
  projectId: string;
  title: string;
  type: string;
  source: string;
  imagePath?: string;
  notes?: string;
  likes: string[];
  dislikes: string[];
  tags: string[];
  analysisStatus: ReferenceStatus;
  compatibility?: string;
  createdAt: ISODateTime;
}

export interface DesignSession {
  id: string;
  projectId: string;
  type: DesignSessionType;
  status: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** Canonical identifiers are safe to use as durable record names and links. */
const CANONICAL_SESSION_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

const DESIGN_SESSION_TYPES = [
  "REFERENCE_SCAN",
  "ASSIMILATION",
  "FEATURE_EVOLVE",
  "SAFE_EXECUTION",
  "MANGEKYO_LOOP",
  "GENOME_INIT",
  "DRIFT_AUDIT",
  "RELEASE_GATE",
] as const satisfies readonly DesignSessionType[];

const DESIGN_SESSION_STATUSES = new Set([
  "DRAFT",
  "ANALYZING",
  "RESULT_READY",
  "AWAITING_DECISION",
  "APPROVED",
  "REVISE",
  "REJECT",
  "IDLE",
  "PREPARING",
  "PROPOSING",
  "WAITING_APPROVAL",
  "REVISING",
  "EDITING",
  "RUNNING",
  "CAPTURING",
  "VERIFYING",
  "COMPLETE",
  "REJECTED",
  "FAILED",
  "POLICY_CHECK",
  "COMPARING",
  "DECIDING",
  "FIXING",
  "HUMAN_GATE",
  "BLOCKED",
  "PASS",
  "PASS_WITH_DEBT",
  "NOT_VERIFIED",
  "FAIL",
]);

export function isCanonicalIdentifier(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_SESSION_IDENTIFIER.test(value);
}

export function isCanonicalIsoDateTime(value: unknown): value is ISODateTime {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function isDesignSessionType(value: unknown): value is DesignSessionType {
  return typeof value === "string" && (DESIGN_SESSION_TYPES as readonly string[]).includes(value);
}

export function isKnownDesignSessionStatus(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 &&
    !/[\u0000-\u001f\u007f]/.test(value) && DESIGN_SESSION_STATUSES.has(value);
}

/** Validate the common immutable session envelope before type-specific parsing. */
export function isDesignSessionEnvelope(value: unknown): value is DesignSession {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Partial<DesignSession>;
  return isCanonicalIdentifier(session.id) &&
    isCanonicalIdentifier(session.projectId) &&
    isDesignSessionType(session.type) &&
    isKnownDesignSessionStatus(session.status) &&
    isCanonicalIsoDateTime(session.createdAt) &&
    isCanonicalIsoDateTime(session.updatedAt) &&
    Date.parse(session.updatedAt) >= Date.parse(session.createdAt);
}

export interface DesignDNA {
  id: string;
  referenceIds: string[];
  hierarchy: string[];
  layout: string[];
  spacing: string[];
  typography: string[];
  colorLogic: string[];
  componentGeometry: string[];
  navigation: string[];
  interaction: string[];
  motion: string[];
  density: string[];
  emotionalTone: string[];
  visualWeight: string[];
  keep: string[];
  reject: string[];
  adapt: string[];
  invent: string[];
}

export interface FeatureBrief {
  name: string;
  goal: string;
  description: string;
  constraints: string[];
  mustKeep: string[];
  mustNotChange: string[];
  successCriteria: string[];
}

export interface UXImpact {
  area: string;
  severity: FindingSeverity;
  reason: string;
  affectedRoutes: string[];
  affectedComponents: string[];
  decisionRequired: boolean;
}

export interface DesignApproach {
  id: string;
  title: string;
  summary: string;
  recommended: boolean;
  pros: string[];
  cons: string[];
  uxImpact: UXImpact[];
  estimatedComplexity: string;
  genomeFit: string;
  likelyFiles: string[];
  status: string;
}

export interface ChangeProposal {
  id: string;
  sessionId: string;
  summary: string;
  reason: string;
  filesToCreate: string[];
  filesToModify: string[];
  filesToDelete: string[];
  componentsAffected: string[];
  screensAffected: string[];
  uxImpact: UXImpact[];
  visualImpact: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  requiresHumanApproval: boolean;
  policyViolations: string[];
  status: string;
}

export interface Approval {
  id: string;
  proposalId: string;
  decision: "APPROVED" | "REJECTED" | "REVISION_REQUESTED";
  scope: string;
  approvedBy: string;
  comment?: string;
  createdAt: ISODateTime;
}

export type SafeMutationTargetDisposition =
  | "NO_TARGET_CHANGE"
  | "FULLY_ROLLED_BACK"
  | "RECONCILIATION_REQUIRED";

export interface SafeMutationFailureEvidence {
  kind: "SAFE_MUTATION_FAILURE";
  targetDisposition: SafeMutationTargetDisposition;
  reason: string;
  affectedPaths: string[];
  occurredAt: ISODateTime;
}

export interface RenderArtifact {
  id: string;
  sessionId: string;
  roundId: string;
  route: string;
  viewport: string;
  viewportWidth: number;
  viewportHeight: number;
  imagePath: string;
  capturedAt: ISODateTime;
  sourceRevision: RenderSourceRevision;
}

export interface GitStatusEntry {
  index: string;
  workingTree: string;
  path: string;
  originalPath?: string;
}

export type RenderSourcePathEvidence =
  | {
      path: string;
      state: "MISSING";
    }
  | {
      path: string;
      state: "FILE";
      mode: number;
      size: number;
      contentHash: string;
    };

export type RenderSourceRevision =
  | {
      kind: "GIT";
      available: true;
      head: string;
      branch: string;
      status: "CLEAN" | "DIRTY";
      entries: GitStatusEntry[];
      truncated: boolean;
      worktreeFingerprint: string;
      fileCount: number;
      requiredPathEvidence: RenderSourcePathEvidence[];
    }
  | {
      kind: "UNVERSIONED";
      available: false;
      reason: "NOT_A_GIT_WORKSPACE" | "GIT_EVIDENCE_UNAVAILABLE";
    }
  | {
      kind: "UNVERSIONED";
      available: true;
      truncated: false;
      worktreeFingerprint: string;
      fileCount: number;
      requiredPathEvidence: RenderSourcePathEvidence[];
    };

export interface VisualRound {
  roundNumber: number;
  startedAt: ISODateTime;
  completedAt?: ISODateTime;
  beforeRender?: RenderArtifact;
  afterRender?: RenderArtifact;
  filesChanged: string[];
  findingsBefore: VisualFinding[];
  actions: string[];
  findingsAfter: VisualFinding[];
  criticalCount: number;
  importantCount: number;
  polishCount: number;
  uxIntegrity: VisualIntegrityVerification;
  productConsistency: VisualIntegrityVerification;
  accessibility: VisualIntegrityVerification;
  genomeIntegrity: VisualIntegrityVerification;
  genomeEvidenceVersion?: string;
  status: MangekyoStatus;
}

export interface VisualIntegrityVerification {
  status: "PASS" | "REGRESSION" | "CONFLICT" | "NOT_VERIFIED";
  evidence: string[];
}

export interface VisualFinding {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  screen: string;
  description: string;
  evidence: string[];
  reason: string;
  recommendedAction: string;
  status: string;
}

export interface MangekyoRenderTarget {
  route: string;
  viewport: {
    name: string;
    width: number;
    height: number;
  };
}

export interface MangekyoProposalDelta {
  filesToCreate: string[];
  filesToModify: string[];
  filesToDelete: string[];
}

export interface MangekyoPolicyEvaluationEvidence {
  id: string;
  roundNumber: number;
  proposalId: string;
  proposalThreadId?: string;
  proposalDelta?: MangekyoProposalDelta;
  change: AutonomyChange;
  policy: AutonomyPolicy;
  evaluation: AutonomyPolicyEvaluation;
  evaluatedAt: ISODateTime;
}

export interface MangekyoHumanGate {
  id: string;
  roundNumber: number;
  requestedChange: AutonomyChange;
  proposal: ChangeProposal;
  proposalThreadId: string;
  policyEvaluationId: string;
  requestedAt: ISODateTime;
  reasons: string[];
  affectedScope: string[];
  impact: string;
}

export interface MangekyoHumanGateDecision {
  id: string;
  gateId: string;
  decision: "REJECT" | "APPROVE_ONCE" | "EXPAND_SCOPE";
  decidedBy: string;
  createdAt: ISODateTime;
  comment?: string;
  policyAfter?: AutonomyPolicy;
}

export interface MangekyoStopRequest {
  id: string;
  loopSessionId: string;
  sessionVersion: ISODateTime;
  requestedAt: ISODateTime;
  requestedBy: string;
}

export interface MangekyoRoundEvidence {
  round: VisualRound;
  proposal: ChangeProposal;
  proposalThreadId: string;
  policyEvaluationId: string;
  mutationCompletedAt: ISODateTime;
  mutationSourceRevision: RenderSourceRevision;
  visualAnalysisThreadId: string;
  gateDecisionId?: string;
}

export interface MangekyoPendingChangeEvidence {
  roundNumber: number;
  proposal: ChangeProposal;
  proposalThreadId: string;
  policyEvaluationId: string;
  recordedAt: ISODateTime;
}

export interface MangekyoLoopSession extends DesignSession {
  type: "MANGEKYO_LOOP";
  status: MangekyoStatus;
  sourceExecutionSessionId: string;
  sourceDesignSessionId: string;
  approvedApproachId: string;
  directionApprovalId: string;
  approvedDirection: string;
  initialPolicy: AutonomyPolicy;
  policy: AutonomyPolicy;
  renderTarget: MangekyoRenderTarget;
  referenceIds: string[];
  maxRounds: number;
  importantThreshold: number;
  claimedScreens: string[];
  inspectedScreens: string[];
  rounds: MangekyoRoundEvidence[];
  policyEvaluations: MangekyoPolicyEvaluationEvidence[];
  gates: MangekyoHumanGate[];
  gateDecisions: MangekyoHumanGateDecision[];
  pendingChange?: MangekyoPendingChangeEvidence;
  currentGate?: MangekyoHumanGate;
  initialRender?: RenderArtifact;
  finalRender?: RenderArtifact;
  mutationFailure?: {
    targetDisposition: "NO_TARGET_CHANGE" | "ROLLED_BACK" | "RECONCILIATION_REQUIRED";
    affectedPaths: string[];
  };
  stopRequest?: MangekyoStopRequest;
  stopReason?: string;
}

export interface DesignGenome {
  version: string;
  status: "DRAFT" | "APPROVED";
  productIdentity: string;
  uxInvariants: string[];
  visualInvariants: string[];
  motionRules: string[];
  accessibilityRules: string[];
  componentDNA: string[];
  screenFamilies: string[];
  contentVoice: string[];
  intentionalExceptions: string[];
  unconfirmedRules: string[];
}

export type GovernanceClaimCategory =
  | "PRODUCT_IDENTITY"
  | "UX_INVARIANT"
  | "VISUAL_INVARIANT"
  | "MOTION_RULE"
  | "ACCESSIBILITY_RULE"
  | "COMPONENT_DNA"
  | "SCREEN_FAMILY"
  | "CONTENT_VOICE";

export interface GovernanceClaimScope {
  routes: string[];
}

export interface GovernanceVerifiedClaim {
  claimType: "PRODUCT_IDENTITY" | "RULE";
  category: GovernanceClaimCategory;
  statement: string;
  scope: GovernanceClaimScope;
}

export interface GovernanceClaimCitation extends GovernanceVerifiedClaim {
  confidence: "CONFIRMED" | "UNCONFIRMED";
  requestedConfidence: "CONFIRMED" | "UNCONFIRMED";
  evidenceIds: string[];
}

export interface GovernanceInspectedScope {
  representative: true;
  routes: string[];
  evidenceIds: string[];
}

export type GovernanceEvidenceKind =
  | "RENDER"
  | "ROUTE"
  | "NAVIGATION"
  | "COMPONENT"
  | "TOKEN"
  | "DOCUMENT";

export interface GovernanceEvidenceCatalogEntry {
  id: string;
  kind: GovernanceEvidenceKind;
  route: string;
  excerpt: string;
  verifiedClaims: GovernanceVerifiedClaim[];
  authenticatedRenderId?: string;
  renderState?: string;
  renderCapturedAt?: ISODateTime;
  renderSourceRevisionFingerprint?: string;
}

export interface ScreenRecord {
  id: string;
  route: string;
  name: string;
  family: string;
  inheritedRules: string[];
  exceptions: string[];
  requiredStates: string[];
  evidence: string[];
  driftStatus: "NOT_VERIFIED" | "PASS" | "DRIFT" | "INTENTIONAL";
  lastVerified?: ISODateTime;
}

export interface DesignDecision {
  id: string;
  date: ISODateTime;
  status: "DRAFT" | "APPROVED" | "REJECTED";
  scope: string;
  decision: string;
  reason: string;
  alternatives: string[];
  affectedScreens: string[];
  affectedComponents: string[];
  migrationRequired: boolean;
  genomeChanges: string[];
  approvedBy?: "local-user";
}

export interface DriftFinding {
  category: DriftAuditCategory;
  severity: DriftSeverity;
  scope: string;
  evidenceIds: string[];
  genomeRuleId: string;
  expectedRule: string;
  observedEvidence: string[];
  whyItMatters: string;
  recommendedFix: string;
  requiresDesignDecision: boolean;
  status: string;
}

export type DriftAuditCategory =
  | "UX_NAVIGATION"
  | "ACCESSIBILITY_REQUIRED_STATES"
  | "PRODUCT_IDENTITY_SCREEN_FAMILY"
  | "COMPONENTS_TOKENS"
  | "HIERARCHY"
  | "MOTION"
  | "POLISH";

export type DriftAuditScope = "WHOLE_APP" | "SELECTED_SCREENS";
export type DriftAuditEvidenceStatus = "INSPECTED" | "UNAVAILABLE" | "OUT_OF_SCOPE";

export interface DriftAuditScopeEntry {
  screen: string;
  states: string[];
}

export interface DriftAuditEvidence {
  screen: string;
  state?: string;
  status: DriftAuditEvidenceStatus;
  evidenceIds?: string[];
  reason?: string;
}

export interface DriftReport {
  requestedScope: DriftAuditScope;
  expectedScope: DriftAuditScopeEntry[];
  inspectedScope: string[];
  unavailableScope: string[];
  unverifiedScope: string[];
  evidenceIds: string[];
  findings: DriftFinding[];
  overallStatus: ReleaseGateStatus;
}

export type ReleaseGateCheckName =
  | "navigation"
  | "accessibility"
  | "criticalDrift"
  | "newDesignRules"
  | "screenRegistration"
  | "requiredStates"
  | "freshRenders"
  | "decisions"
  | "functionalVerification";

export interface ReleaseGateCheck {
  name: ReleaseGateCheckName;
  status: ReleaseCheckStatus;
  evidence: string[];
  lastVerified?: ISODateTime;
  blockingReason?: string;
}

export interface ReleaseGate {
  scope: string;
  checks: ReleaseGateCheck[];
  navigation: ReleaseCheckStatus;
  accessibility: ReleaseCheckStatus;
  criticalDrift: ReleaseCheckStatus;
  newDesignRules: ReleaseCheckStatus;
  screenRegistration: ReleaseCheckStatus;
  requiredStates: ReleaseCheckStatus;
  freshRenders: ReleaseCheckStatus;
  decisions: ReleaseCheckStatus;
  functionalVerification: ReleaseCheckStatus;
  status: ReleaseGateStatus;
}
