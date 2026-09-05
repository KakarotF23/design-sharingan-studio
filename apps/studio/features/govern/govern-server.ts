import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import type { DesignSession, DriftReport, Project, ReleaseGate } from "@design-sharingan/core";
import {
  isCanonicalIdentifier,
  isDesignSessionEnvelope,
} from "@design-sharingan/core";
import {
  evaluateReleaseGate,
  initializeGenomeWithCodex,
  runDriftAudit,
} from "@design-sharingan/eternal-engine";
import {
  approveGenome,
  governanceRootFingerprint,
  governanceIsInitialized,
  initializeGovernance,
  isAuthenticatedGenomeDocument,
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
  loadSession,
  saveSession,
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

export type GovernanceSessionType = "GENOME_INIT" | "DRIFT_AUDIT" | "RELEASE_GATE";

interface GovernanceSessionCheckpoint {
  type: GovernanceSessionType;
  status: string;
  entityId: string;
  revision: number;
  artifactFingerprint: string;
  rootFingerprint: string;
}

function canonicalJson(value: unknown): string {
  function sort(entry: unknown): unknown {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, sort(nested)]),
      );
    }
    return entry;
  }
  const serialized = JSON.stringify(sort(value));
  if (serialized === undefined) throw new Error("Governance artifact identity is not serializable");
  return serialized;
}

function governanceArtifactFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function genomeArtifactIdentity(genome: Awaited<ReturnType<typeof readGenome>>): unknown {
  return {
    metadata: genome.metadata,
    value: genome.value,
    payloadHash: genome.payloadHash,
    authority: genome.authority,
  };
}

function driftArtifactIdentity(drift: Awaited<ReturnType<typeof readDriftReport>>): unknown {
  return { metadata: drift.metadata, value: drift.value };
}

function releaseArtifactIdentity(
  release: GovernReleaseProjection,
  drift: Awaited<ReturnType<typeof readDriftReport>>,
): unknown {
  return { release, drift: driftArtifactIdentity(drift) };
}

function governanceSessionId(
  projectId: string,
  checkpoint: GovernanceSessionCheckpoint,
): string {
  return `gov_${createHash("sha256").update(canonicalJson({
    type: checkpoint.type,
    projectId,
    rootFingerprint: checkpoint.rootFingerprint,
    entityId: checkpoint.entityId,
    revision: checkpoint.revision,
    artifactFingerprint: checkpoint.artifactFingerprint,
  }), "utf8").digest("hex")}`;
}

async function genomeSessionCheckpoint(project: Project): Promise<GovernanceSessionCheckpoint> {
  const [genome, rootFingerprint] = await Promise.all([
    readGenome(project.rootPath, project.id),
    governanceRootFingerprint(project.rootPath),
  ]);
  return {
    type: "GENOME_INIT",
    status: genome.value.status,
    entityId: genome.metadata.entityId,
    revision: genome.metadata.revision,
    artifactFingerprint: governanceArtifactFingerprint(genomeArtifactIdentity(genome)),
    rootFingerprint,
  };
}

async function driftSessionCheckpoint(project: Project): Promise<GovernanceSessionCheckpoint> {
  const [drift, rootFingerprint] = await Promise.all([
    readDriftReport(project.rootPath, project.id),
    governanceRootFingerprint(project.rootPath),
  ]);
  return {
    type: "DRIFT_AUDIT",
    status: drift.value.overallStatus,
    entityId: drift.metadata.entityId,
    revision: drift.metadata.revision,
    artifactFingerprint: governanceArtifactFingerprint(driftArtifactIdentity(drift)),
    rootFingerprint,
  };
}

async function releaseSessionCheckpoint(
  project: Project,
  projection: Extract<GovernanceProjection, { initialized: true }>,
): Promise<GovernanceSessionCheckpoint> {
  if (projection.release === undefined) throw new Error("Release projection is unavailable");
  const [drift, rootFingerprint] = await Promise.all([
    readDriftReport(project.rootPath, project.id),
    governanceRootFingerprint(project.rootPath),
  ]);
  return {
    type: "RELEASE_GATE",
    status: projection.release.status,
    entityId: drift.metadata.entityId,
    revision: drift.metadata.revision,
    artifactFingerprint: governanceArtifactFingerprint(releaseArtifactIdentity(projection.release, drift)),
    rootFingerprint,
  };
}

async function persistGovernanceSession(
  project: Project,
  checkpoint: GovernanceSessionCheckpoint,
): Promise<void> {
  const id = governanceSessionId(project.id, checkpoint);
  const session = {
    id,
    projectId: project.id,
    type: checkpoint.type,
    status: checkpoint.status,
    entityId: checkpoint.entityId,
    revision: checkpoint.revision,
    artifactFingerprint: checkpoint.artifactFingerprint,
    rootFingerprint: checkpoint.rootFingerprint,
  };
  try {
    const existing = await loadSession(project.rootPath, project.id, id);
    if (
      existing.type !== session.type ||
      existing.projectId !== session.projectId ||
      (existing as Partial<typeof session>).entityId !== session.entityId ||
      (existing as Partial<typeof session>).revision !== session.revision ||
      (existing as Partial<typeof session>).artifactFingerprint !== session.artifactFingerprint ||
      (existing as Partial<typeof session>).rootFingerprint !== session.rootFingerprint
    ) throw new Error("Governance session identity conflicts with retained evidence");
    if (existing.status === session.status) return;
    await saveSession(project.rootPath, {
      ...existing,
      status: session.status,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const timestamp = new Date().toISOString();
    await saveSession(project.rootPath, {
      ...session,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

function isGovernanceCheckpointSession(
  session: DesignSession,
): session is DesignSession & GovernanceSessionCheckpoint {
  const value = session as unknown as Record<string, unknown>;
  return isDesignSessionEnvelope(session) &&
    Object.keys(value).length === 10 &&
    value.type !== undefined &&
    ["GENOME_INIT", "DRIFT_AUDIT", "RELEASE_GATE"].includes(String(value.type)) &&
    isCanonicalIdentifier(value.entityId) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.artifactFingerprint === "string" && /^[a-f0-9]{64}$/.test(value.artifactFingerprint) &&
    typeof value.rootFingerprint === "string" && /^[a-f0-9]{64}$/.test(value.rootFingerprint);
}

function assertGovernanceCheckpointMatches(
  projectId: string,
  session: DesignSession & GovernanceSessionCheckpoint,
  expected: GovernanceSessionCheckpoint,
): void {
  if (!governanceCheckpointMatches(projectId, session, expected)) {
    throw new Error("Governance report session is stale or does not match authenticated truth");
  }
}

function governanceCheckpointMatches(
  projectId: string,
  session: DesignSession & GovernanceSessionCheckpoint,
  expected: GovernanceSessionCheckpoint,
): boolean {
  return !(
    session.id !== governanceSessionId(projectId, expected) ||
    session.type !== expected.type ||
    session.status !== expected.status ||
    session.entityId !== expected.entityId ||
    session.revision !== expected.revision ||
    session.artifactFingerprint !== expected.artifactFingerprint ||
    session.rootFingerprint !== expected.rootFingerprint
  );
}

/**
 * Re-authenticate a retained governance session against the current signed
 * Genome/audit generation. A status-shaped machine record cannot establish
 * completion because the current durable documents are always authoritative.
 */
export async function authenticateGovernanceReportSession(
  project: Project,
  session: DesignSession,
): Promise<"AUTHENTICATED" | "UNAVAILABLE"> {
  if (session.projectId !== project.id || !isGovernanceCheckpointSession(session)) {
    throw new Error("Governance report session is not an authenticated checkpoint");
  }
  const checkpoint = session as DesignSession & GovernanceSessionCheckpoint;
  if (checkpoint.id !== governanceSessionId(project.id, checkpoint)) {
    throw new Error("Governance report session identity is not canonical");
  }
  if (checkpoint.type === "GENOME_INIT") {
    const [genome, rootFingerprint] = await Promise.all([
      readGenome(project.rootPath, project.id),
      governanceRootFingerprint(project.rootPath),
    ]);
    const expected: GovernanceSessionCheckpoint = {
      type: "GENOME_INIT",
      status: genome.value.status,
      entityId: genome.metadata.entityId,
      revision: genome.metadata.revision,
      artifactFingerprint: governanceArtifactFingerprint(genomeArtifactIdentity(genome)),
      rootFingerprint,
    };
    if (governanceCheckpointMatches(project.id, checkpoint, expected)) {
      if (genome.value.status === "APPROVED" && !isAuthenticatedGenomeDocument(genome)) {
        throw new Error("Approved Genome report session lacks current signed authority");
      }
      return "AUTHENTICATED";
    }
    // Initialization snapshots before the approved revision were not retained
    // in v0.1. Keep only a self-canonical predecessor of the same Genome/root,
    // explicitly unavailable, rather than denying the authenticated rows.
    if (
      checkpoint.entityId === genome.metadata.entityId &&
      checkpoint.rootFingerprint === rootFingerprint &&
      checkpoint.revision < genome.metadata.revision &&
      checkpoint.status === "DRAFT"
    ) return "UNAVAILABLE";
    throw new Error("Governance report session is stale or does not match authenticated truth");
  }
  const drift = await readDriftReport(project.rootPath, project.id);
  if (checkpoint.type === "DRIFT_AUDIT") {
    const rootFingerprint = await governanceRootFingerprint(project.rootPath);
    const expected: GovernanceSessionCheckpoint = {
      type: "DRIFT_AUDIT",
      status: drift.value.overallStatus,
      entityId: drift.metadata.entityId,
      revision: drift.metadata.revision,
      artifactFingerprint: governanceArtifactFingerprint(driftArtifactIdentity(drift)),
      rootFingerprint,
    };
    if (governanceCheckpointMatches(project.id, checkpoint, expected)) {
      return "AUTHENTICATED";
    }
    // Signed audit generations are bounded and may later be retired at their
    // retention limit. A canonical predecessor is retained as unavailable;
    // it cannot inherit the current generation's status or authority.
    if (
      checkpoint.entityId === drift.metadata.entityId &&
      checkpoint.rootFingerprint === rootFingerprint &&
      checkpoint.revision < drift.metadata.revision
    ) return "UNAVAILABLE";
    throw new Error("Governance report session is stale or does not match authenticated truth");
  }
  const projection = await loadGovernanceProjection(project);
  if (!projection.initialized || projection.release === undefined) {
    throw new Error("Release report session lacks current authenticated release truth");
  }
  assertGovernanceCheckpointMatches(project.id, checkpoint, await releaseSessionCheckpoint(project, projection));
  return "AUTHENTICATED";
}

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
  const projection = await loadGovernanceProjection(project);
  if (!projection.initialized) throw new Error("Initialized Genome projection is unavailable");
  await persistGovernanceSession(project, await genomeSessionCheckpoint(project));
  return projection;
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
  const projection = await loadGovernanceProjection(project);
  if (!projection.initialized) throw new Error("Approved Genome projection is unavailable");
  await persistGovernanceSession(project, await genomeSessionCheckpoint(project));
  return projection;
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
    approvedGenome: genome,
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
  const projection = await loadGovernanceProjection(project);
  if (!projection.initialized || projection.drift === undefined) {
    throw new Error("Drift audit projection is unavailable");
  }
  await persistGovernanceSession(project, await driftSessionCheckpoint(project));
  return projection;
}

export async function evaluateProjectRelease(
  project: Project,
): Promise<GovernanceProjection> {
  const projection = await loadGovernanceProjection(project);
  if (!projection.initialized || projection.release === undefined) return projection;
  await persistGovernanceSession(project, await releaseSessionCheckpoint(project, projection));
  return projection;
}
