import type {
  AutonomyChange,
  FindingCategory,
  FindingSeverity,
  MangekyoStatus,
} from "@design-sharingan/core";

export interface MangekyoRenderView {
  id: string;
  route: string;
  viewport: string;
  capturedAt: string;
}

export interface MangekyoFindingView {
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

export interface MangekyoRoundView {
  roundNumber: number;
  status: MangekyoStatus;
  objective: string;
  afterRender?: MangekyoRenderView;
  findings: MangekyoFindingView[];
  criticalCount: number;
  importantCount: number;
  polishCount: number;
  filesChanged: string[];
}

export interface MangekyoGateView {
  id: string;
  requestedChange: AutonomyChange;
  requestedChangeSummary: string;
  reasons: string[];
  affectedScope: string[];
  impact: string;
}

export interface MangekyoSessionView {
  id: string;
  status: MangekyoStatus;
  currentRound: number;
  maxRounds: number;
  route: string;
  viewport: string;
  activity: string;
  initialRender?: MangekyoRenderView;
  currentRender?: MangekyoRenderView;
  rounds: MangekyoRoundView[];
  currentGate?: MangekyoGateView;
  stopReason?: string;
}

export interface MangekyoReferenceView {
  id: string;
  title: string;
}

export interface MangekyoDataView {
  session?: MangekyoSessionView;
  references: MangekyoReferenceView[];
}
