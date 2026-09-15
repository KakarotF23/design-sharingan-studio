import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Project } from "@design-sharingan/core";
import { CodexAgent } from "@design-sharingan/agent-runtime";
import { loadApprovedGenomeContext } from "@design-sharingan/governance";
import { captureRender, captureWorkspaceSourceRevision, startProjectRenderSession } from "@design-sharingan/render-engine";
import { analyzeRender, type VisualAnalysisWireOutput } from "@design-sharingan/visual-engine";
import { loadSafeExecutionState, verifySafeExecution } from "@design-sharingan/project-adapters";
import { createAnalysisStagingDirectory } from "../projects/project-locator";

export async function verifyApprovedSafeMutation(project: Project, sessionId: string) {
  let renderSession: Awaited<ReturnType<typeof startProjectRenderSession>> | undefined;
  let staging: string | undefined;
  const safe = await loadSafeExecutionState(project.rootPath, project.id);
  const genome = await loadApprovedGenomeContext(project.rootPath, project.id);
  return verifySafeExecution(project.rootPath, project.id, sessionId, {
    async run() { renderSession = await startProjectRenderSession(project); },
    async capture(source) { if (renderSession === undefined) throw new Error("Render session is unavailable"); const requestedRoute = source.proposal.screensAffected.find((route) => renderSession!.workspace.routes.includes(route)); return (await captureRender({ workspace: renderSession.workspace, baseUrl: renderSession.baseUrl, route: requestedRoute ?? renderSession.workspace.routes[0] ?? "/", viewport: { name: "desktop", width: 1280, height: 720 }, sessionId, roundId: `safe-${randomUUID()}`, requiredSourcePaths: source.mutationEvidence.filesChanged })).artifact; },
    async currentSourceFingerprint() { if (renderSession === undefined) throw new Error("Render workspace is unavailable"); const revision = await captureWorkspaceSourceRevision(renderSession.workspace); if (!revision.available || revision.truncated) throw new Error("Current source evidence is unavailable"); return revision.worktreeFingerprint; },
    async verify(render) {
      staging = await createAnalysisStagingDirectory(project.rootPath);
      const wire: VisualAnalysisWireOutput = { verification: { uxIntegrity: { status: "PASS", evidence: ["The existing primary task and navigation remain rendered."] }, productConsistency: { status: "PASS", evidence: ["The approved fixture metadata change preserves the rendered component language."] }, accessibility: { status: "PASS", evidence: ["No observable accessibility regression in the scoped render."] }, genomeIntegrity: { status: genome === undefined ? "NOT_VERIFIED" : "PASS", evidence: [genome === undefined ? "No approved Genome exists; no Genome PASS is claimed." : "The approved Genome rules remain visible in the scoped render."] } }, findings: [] };
      const agent = process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1" ? { async run<T>() { return { threadId: "fake-safe-verification", finalResponse: JSON.stringify(wire), structured: wire as T, items: [] }; } } : new CodexAgent();
      const analysis = await analyzeRender({ projectId: project.id, projectRoot: project.rootPath, analysisWorkingDirectory: staging, screen: render.route, currentRender: render, referenceImages: [], comparisonMode: "APPROVED_DIRECTION", productContext: { name: project.name, approvedDirection: `${safe.designApproach.title}: ${safe.designApproach.summary}`.slice(0, 2000), uxInvariants: safe.featureBrief.mustNotChange, designSystem: safe.featureBrief.mustKeep }, ...(genome === undefined ? {} : { genome: genome.genome }) }, { agent, createId: randomUUID });
      const current = await loadApprovedGenomeContext(project.rootPath, project.id);
      if (JSON.stringify(current?.evidence) !== JSON.stringify(genome?.evidence)) throw new Error("Genome changed during Safe verification");
      return { threadId: analysis.threadId, verification: analysis.verification, findings: analysis.findings };
    },
    async stop() { await renderSession?.stop().catch(() => undefined); if (staging !== undefined) await rm(staging, { recursive: true, force: true }).catch(() => undefined); },
  });
}
