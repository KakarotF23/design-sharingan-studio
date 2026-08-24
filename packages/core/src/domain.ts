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

export interface RenderArtifact {
  id: string;
  sessionId: string;
  route: string;
  viewport: string;
  imagePath: string;
  capturedAt: ISODateTime;
}

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
  uxIntegrity: string;
  genomeIntegrity: string;
  status: MangekyoStatus;
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

export interface ScreenRecord {
  id: string;
  route: string;
  name: string;
  family: string;
  inheritedRules: string[];
  exceptions: string[];
  requiredStates: string[];
  evidence: string[];
  driftStatus: string;
  lastVerified?: ISODateTime;
}

export interface DesignDecision {
  id: string;
  date: ISODateTime;
  status: string;
  scope: string;
  decision: string;
  reason: string;
  alternatives: string[];
  affectedScreens: string[];
  affectedComponents: string[];
  migrationRequired: boolean;
  genomeChanges: string[];
  approvedBy?: string;
}

export interface DriftFinding {
  severity: DriftSeverity;
  scope: string;
  expectedRule: string;
  observedEvidence: string[];
  whyItMatters: string;
  recommendedFix: string;
  requiresDesignDecision: boolean;
  status: string;
}

export interface ReleaseGate {
  scope: string;
  checks: string[];
  navigation: ReleaseGateStatus;
  accessibility: ReleaseGateStatus;
  criticalDrift: ReleaseGateStatus;
  newDesignRules: ReleaseGateStatus;
  screenRegistration: ReleaseGateStatus;
  requiredStates: ReleaseGateStatus;
  freshRenders: ReleaseGateStatus;
  decisions: ReleaseGateStatus;
  functionalVerification: ReleaseGateStatus;
  status: ReleaseGateStatus;
}
