import { rm } from "node:fs/promises";
import type { DriftReport, Project, ReleaseGate } from "@design-sharingan/core";
import {
  evaluateReleaseGate,
  initializeGenomeWithCodex,
  runDriftAudit,
} from "@design-sharingan/eternal-engine";
import {
  approveGenome,
  governanceIsInitialized,
  initializeGovernance,
  readDesignDecisions,
  readDriftReport,
  readEvidenceCatalog,
  readGenome,
  readScreenRegistry,
  saveDriftReport,
} from "@design-sharingan/governance";
import {
  collectGovernanceEvidence,
  detectProject,
  type ProjectWorkspace,
} from "@design-sharingan/project-adapters";
import { captureWorkspaceSourceRevision } from "@design-sharingan/render-engine";
import { createAnalysisStagingDirectory } from "../projects/project-locator";

export interface GovernGenomeProjection {
  status: "DRAFT" | "APPROVED";
  authority: "NON-AUTHORITATIVE" | "AUTHORITATIVE";
  revision: number;
  version: string;
  payloadHash: string;
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

export interface GovernScreenProjection {
  id: string;
  route: string;
  name: string;
  family: string;
  inheritedRules: string[];
  exceptions: string[];
  requiredStates: string[];
  evidence: string[];
  driftStatus: string;
  lastVerified?: string;
}

export interface GovernReleaseProjection extends ReleaseGate {
  nonBlockingDebt: { finding: string; rationale: string; documentedBy: string }[];
}

export type GovernanceProjection =
  | { initialized: false }
  | {
      initialized: true;
      genome: GovernGenomeProjection;
      screens: GovernScreenProjection[];
      drift?: DriftReport;
      release?: GovernReleaseProjection;
    };

function missingDriftReport(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function workspaceFor(project: Project): Promise<ProjectWorkspace> {
  const detection = await detectProject(project.rootPath);
  return {
    ...project,
    framework: detection.framework,
    packageManager: detection.packageManager,
    devCommand: detection.devCommand,
    renderTarget: detection.renderTarget,
    scripts: detection.scripts,
    routes: detection.routes,
    componentDirectories: detection.componentDirectories,
    designDocuments: detection.designDocuments,
    hasGit: detection.hasGit,
    capabilities: detection.capabilities,
  };
}

async function freshRenderEvidenceIds(
  project: Project,
): Promise<{ ids: Set<string>; sourceRevisionFingerprint?: string }> {
  const [workspace, catalog] = await Promise.all([
    workspaceFor(project),
    readEvidenceCatalog(project.rootPath, project.id),
  ]);
  const current = await captureWorkspaceSourceRevision(workspace).catch(() => undefined);
  if (current?.available !== true) return { ids: new Set() };
  return {
    sourceRevisionFingerprint: current.worktreeFingerprint,
    ids: new Set(catalog.filter((entry) =>
    entry.kind === "RENDER" &&
    entry.authenticatedRenderId !== undefined &&
    entry.renderState !== undefined &&
    entry.renderCapturedAt !== undefined &&
    entry.renderSourceRevisionFingerprint === current.worktreeFingerprint,
    ).map(({ id }) => id)),
  };
}

async function evaluateProjectReleaseGate(
  project: Project,
  report: DriftReport,
): Promise<GovernReleaseProjection> {
  const [registry, decisions, catalog, freshEvidence] = await Promise.all([
    readScreenRegistry(project.rootPath, project.id),
    readDesignDecisions(project.rootPath, project.id),
    readEvidenceCatalog(project.rootPath, project.id),
    freshRenderEvidenceIds(project),
  ]);
  const verifiedAt = registry.records.flatMap(({ lastVerified }) => lastVerified === undefined ? [] : [lastVerified])
    .sort()
    .at(-1);
  const allRegistered = registry.records.length > 0 && registry.records.every(({ driftStatus }) => driftStatus !== "NOT_VERIFIED");
  const allFresh = allRegistered && registry.records.every((record) =>
    record.evidence.some((id) => freshEvidence.ids.has(id)),
  );
  const requiredStates = report.unavailableScope.length === 0 && report.unverifiedScope.length === 0;
  const critical = report.findings.some(({ severity }) => severity === "CRITICAL");
  const unresolvedDecision = report.findings.some(({ requiresDesignDecision, status }) =>
    requiresDesignDecision && status !== "INTENTIONAL",
  );
  const evidence = report.evidenceIds.length > 0 && verifiedAt !== undefined
    ? { evidence: report.evidenceIds, lastVerified: verifiedAt }
    : { evidence: [] };
  const authenticatedEvidence = catalog.flatMap((entry) => {
    if (!report.evidenceIds.includes(entry.id) || entry.renderCapturedAt === undefined || entry.renderSourceRevisionFingerprint === undefined) return [];
    return [{
      id: entry.id,
      projectId: project.id,
      route: entry.route,
      state: entry.renderState ?? "default",
      kind: entry.kind === "RENDER" ? "RENDER" as const : "EVIDENCE" as const,
      capturedAt: entry.renderCapturedAt,
      sourceRevisionFingerprint: entry.renderSourceRevisionFingerprint,
      ...(report.findings.some((finding) => finding.severity === "POLISH" && finding.evidenceIds.includes(entry.id))
        ? { findingCategory: "POLISH" as const } : {}),
    }];
  });
  return evaluateReleaseGate({
    scope: {
      requestedScope: report.requestedScope,
      expectedScope: report.expectedScope,
      inspectedScope: report.inspectedScope,
      unavailableScope: report.unavailableScope,
    },
    navigation: "NOT_VERIFIED",
    accessibility: "NOT_VERIFIED",
    criticalDrift: critical ? "FAIL" : "PASS",
    newDesignRules: unresolvedDecision ? "FAIL" : "PASS",
    screenRegistration: allRegistered ? "PASS" : "NOT_VERIFIED",
    requiredStates: requiredStates ? "PASS" : "FAIL",
    freshRenders: allFresh ? "PASS" : "FAIL",
    decisions: decisions.decisions.some(({ status }) => status === "DRAFT") ? "NOT_VERIFIED" : "PASS",
    functionalVerification: "NOT_VERIFIED",
    projectId: project.id,
    currentSourceRevisionFingerprint: freshEvidence.sourceRevisionFingerprint,
    authenticatedEvidence,
    approvedDecisionIds: decisions.decisions
      .filter((decision) => decision.status === "APPROVED" && decision.approvedBy === "local-user")
      .map(({ id }) => id),
    unresolvedFindings: report.findings
      .filter((finding) => finding.status !== "RESOLVED" && finding.status !== "INTENTIONAL")
      .map((finding) => ({
        finding: `${finding.scope}: ${finding.expectedRule}`,
        severity: finding.severity,
        evidenceIds: finding.evidenceIds,
      })),
    evidence: {
      criticalDrift: evidence,
      newDesignRules: evidence,
      screenRegistration: allRegistered ? evidence : { evidence: [] },
      requiredStates: requiredStates ? evidence : { evidence: [], blockingReason: "One or more required states have no authenticated render." },
      freshRenders: allFresh ? evidence : { evidence: [], blockingReason: "Fresh final render evidence is unavailable or stale." },
      decisions: evidence,
    },
  });
}

export async function loadGovernanceProjection(
  project: Project,
): Promise<GovernanceProjection> {
  if (!(await governanceIsInitialized(project.rootPath))) {
    return { initialized: false };
  }
  const [genome, registry] = await Promise.all([
    readGenome(project.rootPath, project.id),
    readScreenRegistry(project.rootPath, project.id),
  ]);
  let drift: DriftReport | undefined;
  try {
    drift = (await readDriftReport(project.rootPath, project.id)).value;
  } catch (error) {
    if (!missingDriftReport(error)) throw error;
  }
  const release = drift === undefined
    ? undefined
    : await evaluateProjectReleaseGate(project, drift);
  return {
    initialized: true,
    genome: {
      status: genome.value.status,
      authority: genome.authority === "AUTHORITATIVE" ? "AUTHORITATIVE" : "NON-AUTHORITATIVE",
      revision: genome.metadata.revision,
      version: genome.value.version,
      payloadHash: genome.payloadHash,
      productIdentity: genome.value.productIdentity,
      uxInvariants: genome.value.uxInvariants,
      visualInvariants: genome.value.visualInvariants,
      motionRules: genome.value.motionRules,
      accessibilityRules: genome.value.accessibilityRules,
      componentDNA: genome.value.componentDNA,
      screenFamilies: genome.value.screenFamilies,
      contentVoice: genome.value.contentVoice,
      intentionalExceptions: genome.value.intentionalExceptions,
      unconfirmedRules: genome.value.unconfirmedRules,
    },
    screens: registry.records.map((screen) => ({ ...screen })),
    ...(drift === undefined ? {} : { drift }),
    ...(release === undefined ? {} : { release }),
  };
}

export async function initializeProjectGovernance(
  project: Project,
): Promise<GovernanceProjection> {
  if (await governanceIsInitialized(project.rootPath)) {
    throw new Error("Governance is already initialized");
  }
  const detection = await detectProject(project.rootPath);
  if (!detection.capabilities.canReadFiles || !detection.capabilities.canWriteFiles) {
    throw new Error("Project capabilities do not allow governance initialization");
  }
  const representativeRoutes = (
    detection.routes.length > 0
      ? detection.routes.slice(0, 3)
      : [detection.renderTarget ?? "/"]
  );
  const routes = [...new Set([...detection.routes, ...representativeRoutes])];
  const analysisWorkingDirectory = await createAnalysisStagingDirectory(
    project.rootPath,
  );
  const evidenceCatalog = await collectGovernanceEvidence({
    rootPath: project.rootPath,
    projectId: project.id,
    routes: representativeRoutes,
    componentDirectories: detection.componentDirectories,
    designDocuments: detection.designDocuments,
  });
  let result: Awaited<ReturnType<typeof initializeGenomeWithCodex>>;
  try {
    result = await initializeGenomeWithCodex(
      {
        workingDirectory: analysisWorkingDirectory,
        projectContext: {
          projectId: project.id,
          name: project.name,
          framework: detection.framework,
          routes,
          componentDirectories: [...detection.componentDirectories],
          designDocuments: [...detection.designDocuments],
        },
        representativeEvidence: representativeRoutes.map((route) => ({
          route,
          observations: [
            "Authenticated project inspection detected this current route or render target.",
            "Evidence is representative only and does not establish whole-product coverage.",
          ],
          evidence: evidenceCatalog
            .filter((evidence) => evidence.route === route)
            .map(({ id, kind, excerpt, verifiedClaims }) => ({
              id,
              kind,
              excerpt,
              verifiedClaims,
            })),
        })),
      },
    );
  } finally {
    await rm(/* turbopackIgnore: true */ analysisWorkingDirectory, {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
  await initializeGovernance({
    rootPath: project.rootPath,
    projectId: project.id,
    genome: result.genome,
    screens: result.screens,
    decisions: [],
    evidenceCatalog,
    inspectedScope: result.inspectedScope,
    claimCitations: result.claimCitations,
  });
  return loadGovernanceProjection(project);
}

export async function approveProjectGenome(
  project: Project,
  expectedRevision: number,
  expectedPayloadHash: string,
): Promise<GovernanceProjection> {
  await approveGenome(project.rootPath, project.id, {
    approvedBy: "local-user",
    expectedRevision,
    expectedPayloadHash,
  });
  return loadGovernanceProjection(project);
}

export async function auditProjectDrift(
  project: Project,
): Promise<GovernanceProjection> {
  const [genome, registry, workspace] = await Promise.all([
    readGenome(project.rootPath, project.id),
    readScreenRegistry(project.rootPath, project.id),
    workspaceFor(project),
  ]);
  if (!workspace.capabilities.canAudit || !workspace.capabilities.canWriteFiles) {
    throw new Error("Project capabilities do not allow a governed drift audit");
  }
  const routes = registry.records.map(({ route }) => route);
  if (routes.length === 0 || routes.length > 16) {
    throw new Error("Drift audit scope must be explicitly bounded to supported registered routes");
  }
  const [newEvidence, existingEvidence, currentRevision] = await Promise.all([
    collectGovernanceEvidence({
      rootPath: project.rootPath,
      projectId: project.id,
      routes,
      componentDirectories: workspace.componentDirectories,
      designDocuments: workspace.designDocuments,
    }),
    readEvidenceCatalog(project.rootPath, project.id),
    captureWorkspaceSourceRevision(workspace).catch(() => undefined),
  ]);
  const catalog = [...existingEvidence, ...newEvidence];
  const freshRenderByRoute = new Map<string, string[]>();
  if (currentRevision?.available === true) {
    for (const entry of catalog) {
      if (
        entry.kind === "RENDER" &&
        entry.authenticatedRenderId !== undefined &&
        entry.renderState !== undefined &&
        entry.renderCapturedAt !== undefined &&
        entry.renderSourceRevisionFingerprint === currentRevision.worktreeFingerprint
      ) {
        freshRenderByRoute.set(entry.route, [
          ...(freshRenderByRoute.get(entry.route) ?? []),
          entry.id,
        ]);
      }
    }
  }
  const report = await runDriftAudit({
    requestedScope: "WHOLE_APP",
    approvedGenome: genome.value,
    expectedScope: registry.records.map(({ route, requiredStates }) => ({
      screen: route,
      states: requiredStates,
    })),
    evidence: registry.records.flatMap((record) => record.requiredStates.map((state) => {
      const freshEvidence = state === "default" ? freshRenderByRoute.get(record.route) ?? [] : [];
      return freshEvidence.length > 0
        ? { screen: record.route, state, status: "INSPECTED" as const, evidenceIds: freshEvidence }
        : {
            screen: record.route,
            state,
            status: "UNAVAILABLE" as const,
            reason: "No authenticated fresh rendered evidence exists for this required state.",
          };
    })),
  });
  const verifiedRegistry = registry.records.flatMap((record) => {
    const states = record.requiredStates;
    const evidenceIds = states.flatMap((state) => state === "default" ? freshRenderByRoute.get(record.route) ?? [] : []);
    const hasObservedDrift = report.findings.some((finding) => finding.scope.startsWith(`${record.route}#`));
    return hasObservedDrift && states.length > 0 && evidenceIds.length > 0 && states.every((state) => state === "default")
      ? [{
          screen: record.route,
          states,
          status: "DRIFT" as const,
          evidenceIds,
          lastVerified: new Date().toISOString(),
        }]
      : [];
  });
  await saveDriftReport({
    rootPath: project.rootPath,
    projectId: project.id,
    expectedRevision: registry.metadata.revision,
    evidenceCatalog: newEvidence,
    report,
    verifiedRegistry,
  });
  return loadGovernanceProjection(project);
}

export async function evaluateProjectRelease(
  project: Project,
): Promise<GovernanceProjection> {
  return loadGovernanceProjection(project);
}
