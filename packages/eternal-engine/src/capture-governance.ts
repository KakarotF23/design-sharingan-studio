import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { DriftAuditScopeEntry, GovernanceClaimCategory, GovernanceEvidenceCatalogEntry, Project } from "@design-sharingan/core";
import { readGenome, readScreenRegistry, readDriftReport, saveDriftReport, loadApprovedGenomeContext } from "@design-sharingan/governance";
import { saveGovernanceCaptureSession, type GovernanceCaptureSession } from "@design-sharingan/project-adapters";
import { captureRender, captureWorkspaceSourceRevision, inspectBrowserChecks, startProjectRenderSession } from "@design-sharingan/render-engine";
import { analyzeRender, type VisualAnalysisAgent } from "@design-sharingan/visual-engine";
import { approvedRules, AUDIT_ORDER, observationsForApprovedGenome, runDriftAudit, type DriftAuditEvidenceInput } from "./audit";
import { loadGovernanceProjection, recordProjectDriftCheckpoint } from "./project-governance";

export interface GovernCaptureScope { requestedScope: "SELECTED_SCREENS" | "WHOLE_APP"; expectedScope: DriftAuditScopeEntry[] }
export async function captureProjectGovernance(project: Project, scope: GovernCaptureScope, dependencies: { createAnalysisStagingDirectory(root: string): Promise<string>; agent: VisualAnalysisAgent }) {
  const [genome, registry, context] = await Promise.all([readGenome(project.rootPath, project.id), readScreenRegistry(project.rootPath, project.id), loadApprovedGenomeContext(project.rootPath, project.id)]);
  if (context === undefined) throw new Error("An approved Genome is required for governed capture");
  if (!["SELECTED_SCREENS", "WHOLE_APP"].includes(scope.requestedScope) || scope.expectedScope.length === 0 || scope.expectedScope.length > 8 || new Set(scope.expectedScope.map(({ screen }) => screen)).size !== scope.expectedScope.length || scope.expectedScope.some((selected) => !Array.isArray(selected.states) || selected.states.length === 0 || selected.states.length > 4 || new Set(selected.states).size !== selected.states.length || !registry.records.some((screen) => screen.route === selected.screen && selected.states.every((state) => screen.requiredStates.includes(state)))) || scope.expectedScope.flatMap(({ states }) => states).length > 16) throw new Error("Capture scope must be a bounded registered screen/state selection");
  if (scope.requestedScope === "WHOLE_APP" && (scope.expectedScope.length !== registry.records.length || registry.records.some((screen) => !scope.expectedScope.some((selected) => selected.screen === screen.route && selected.states.length === screen.requiredStates.length)))) throw new Error("Whole-product capture must include every registered required state");
  const renderer = await startProjectRenderSession(project);
  const proofs: GovernanceCaptureSession[] = [];
  const evidence: DriftAuditEvidenceInput[] = [];
  const catalog: GovernanceEvidenceCatalogEntry[] = [];
  let staging: string | undefined;
  try {
    staging = await dependencies.createAnalysisStagingDirectory(project.rootPath);
    for (const selected of scope.expectedScope) for (const state of selected.states) {
      try {
        const browserChecks = await inspectBrowserChecks({ baseUrl: renderer.baseUrl, route: selected.screen, state });
        const id = randomUUID(); const startedAt = new Date().toISOString();
        const render = (await captureRender({ workspace: renderer.workspace, baseUrl: renderer.baseUrl, route: selected.screen, expectedState: state, viewport: { name: "desktop", width: 1280, height: 720 }, sessionId: id, roundId: "governance" })).artifact;
        const analysis = await analyzeRender({ projectId: project.id, projectRoot: project.rootPath, analysisWorkingDirectory: staging, screen: selected.screen, currentRender: render, referenceImages: [], comparisonMode: "APPROVED_DIRECTION", genome: context.genome, productContext: { name: project.name, approvedDirection: context.genome.productIdentity, uxInvariants: context.genome.uxInvariants, designSystem: [...context.genome.visualInvariants, ...context.genome.componentDNA] } }, { agent: dependencies.agent, createId: randomUUID });
        const checks = analysis.verification;
        const verifiedCategories = AUDIT_ORDER.filter((category) => {
          if (category === "UX_NAVIGATION") return browserChecks.navigation === "PASS" && checks.uxIntegrity.status === "PASS";
          if (category === "ACCESSIBILITY_REQUIRED_STATES") return browserChecks.accessibility === "PASS" && checks.accessibility.status === "PASS";
          if (category === "MOTION" && context.genome.motionRules.length > 0) return false; // A still cannot prove motion.
          return checks.productConsistency.status === "PASS" && checks.genomeIntegrity.status === "PASS";
        }).map((category) => ({ category, evidence: category === "MOTION" ? ["No approved motion rules exist in this scope; no motion behavior is claimed."] : [...checks.genomeIntegrity.evidence, ...browserChecks.evidence].slice(0, 16) }));
        const proof: GovernanceCaptureSession = { id, projectId: project.id, type: "GOVERNANCE_CAPTURE", status: "COMPLETE", createdAt: startedAt, updatedAt: new Date().toISOString(), state, render, genomeEvidence: context.evidence, browserChecks, analysis: { threadId: analysis.threadId, findings: analysis.findings, verification: analysis.verification }, verifiedCategories };
        await saveGovernanceCaptureSession(project.rootPath, proof);
        proofs.push(proof);
        const categoryMap: Record<string, GovernanceClaimCategory> = { UX_NAVIGATION: "UX_INVARIANT", ACCESSIBILITY_REQUIRED_STATES: "ACCESSIBILITY_RULE", PRODUCT_IDENTITY_SCREEN_FAMILY: "PRODUCT_IDENTITY", COMPONENTS_TOKENS: "VISUAL_INVARIANT", HIERARCHY: "VISUAL_INVARIANT", MOTION: "MOTION_RULE", POLISH: "VISUAL_INVARIANT" };
        const entry: GovernanceEvidenceCatalogEntry = { id: `ev_${id}`, kind: "RENDER", route: render.route, excerpt: browserChecks.evidence.join(" ").slice(0, 1000), authenticatedRenderId: render.id, renderState: state, renderCapturedAt: render.capturedAt, renderSourceRevisionFingerprint: render.sourceRevision.available ? render.sourceRevision.worktreeFingerprint : undefined, verifiedClaims: [] };
        for (const category of AUDIT_ORDER) for (const rule of approvedRules(context.genome, category)) {
          const claimCategory = category === "COMPONENTS_TOKENS" && context.genome.componentDNA.includes(rule) ? "COMPONENT_DNA" : category === "PRODUCT_IDENTITY_SCREEN_FAMILY" && context.genome.screenFamilies.includes(rule) ? "SCREEN_FAMILY" : categoryMap[category]!;
          if (!entry.verifiedClaims.some((claim) => claim.category === claimCategory && claim.statement === rule)) entry.verifiedClaims.push({ claimType: claimCategory === "PRODUCT_IDENTITY" ? "PRODUCT_IDENTITY" : "RULE", category: claimCategory, statement: rule, scope: { routes: [render.route] } });
        }
        catalog.push(entry);
        const observations = observationsForApprovedGenome(analysis.findings, context.genome);
        evidence.push({ screen: render.route, state, status: "INSPECTED", evidenceIds: [entry.id], observations, verifiedCategories });
      } catch { evidence.push({ screen: selected.screen, state, status: "UNAVAILABLE", reason: "The requested state or its fresh browser/visual verification could not be established." }); }
    }
    const current = await captureWorkspaceSourceRevision(renderer.workspace);
    const latest = await loadApprovedGenomeContext(project.rootPath, project.id);
    if (!isDeepStrictEqual(latest?.evidence, context.evidence) || !current.available || proofs.some((proof) => !proof.render.sourceRevision.available || proof.render.sourceRevision.worktreeFingerprint !== current.worktreeFingerprint)) throw new Error("Genome or source changed during governed capture");
    const report = await runDriftAudit({ ...scope, approvedGenome: genome, evidence });
    const runtimeMissing = proofs.filter((proof) => proof.browserChecks.functionalVerification !== "PASS");
    for (const proof of runtimeMissing) report.unverifiedScope.push(`${proof.render.route}#${proof.state}: Interactive functionality has not been exercised by the read-only smoke check.`);
    if (runtimeMissing.length > 0) report.overallStatus = "NOT_VERIFIED";
    report.verificationSessionIds = proofs.map(({ id }) => id);
    const previous = await readDriftReport(project.rootPath, project.id).catch((error: unknown) => { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; });
    for (const finding of previous?.value.findings ?? []) {
      const proof = proofs.find((proof) => `${proof.render.route}#${proof.state}` === finding.scope && proof.verifiedCategories.some(({ category }) => category === finding.category));
      if (!proof || finding.requiresDesignDecision || report.findings.some((current) => current.scope === finding.scope && current.category === finding.category)) continue;
      const entry = catalog.find(({ authenticatedRenderId }) => authenticatedRenderId === proof.render.id)!;
      report.findings.push({ ...finding, status: "RESOLVED", evidenceIds: [entry.id], observedEvidence: ["Fresh governed capture rechecked this approved category after the final source change and observed no remaining deviation."] });
    }
    await saveDriftReport({ rootPath: project.rootPath, projectId: project.id, expectedRevision: registry.metadata.revision, evidenceCatalog: catalog, report });
    await recordProjectDriftCheckpoint(project);
    return loadGovernanceProjection(project);
  } finally { await renderer.stop().catch(() => undefined); if (staging !== undefined) await rm(staging, { recursive: true, force: true }).catch(() => undefined); }
}
