import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { CodexAgent } from "@design-sharingan/agent-runtime";
import { assimilateReferences, verifyDesignDirection } from "@design-sharingan/sharingan-engine";
import { detectProject, listReadonlyLearnSessions, loadReferenceDesignDNA, saveReadonlyLearnSession, type ReadonlyLearnSession } from "@design-sharingan/project-adapters";
import { createScanAgent } from "../../../../../features/learn/scan-agent";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { createAnalysisStagingDirectory } from "../../../../../features/projects/project-locator";
import { readProjectJson } from "../../../../../features/projects/project-request";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  try { const project = await resolveProjectRequest((await context.params).projectId); return Response.json({ sessions: await listReadonlyLearnSessions(project.rootPath, project.id) }); }
  catch { return Response.json({ error: "Saved design evidence is unavailable." }, { status: 404 }); }
}
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const parsed = await readProjectJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown> | null;
  if (body === null || typeof body !== "object" || !["ASSIMILATION", "DESIGN_VERIFY"].includes(body.mode as string) || !Array.isArray(body.referenceIds) || body.referenceIds.length > 10 || !body.referenceIds.every((id) => typeof id === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(id)) || new Set(body.referenceIds).size !== body.referenceIds.length) return Response.json({ error: "Choose a bounded design comparison." }, { status: 400 });
  let staging: string | undefined;
  let active: { root: string; session: ReadonlyLearnSession } | undefined;
  try {
    const project = await resolveProjectRequest((await context.params).projectId);
    const analyses = await Promise.all(body.referenceIds.map((id) => loadReferenceDesignDNA(project.rootPath, project.id, id)));
    staging = await createAnalysisStagingDirectory(project.rootPath);
    const timestamp = new Date().toISOString();
    const draft: ReadonlyLearnSession = { id: randomUUID(), projectId: project.id, type: body.mode as "ASSIMILATION" | "DESIGN_VERIFY", status: "DRAFT", createdAt: timestamp, updatedAt: timestamp, referenceIds: body.referenceIds, ...(body.mode === "DESIGN_VERIFY" ? { intendedDirection: body.intendedDirection as string, currentDirection: body.currentDirection as string } : {}) };
    await saveReadonlyLearnSession(project.rootPath, draft);
    const analyzing: ReadonlyLearnSession = { ...draft, status: "ANALYZING", updatedAt: new Date().toISOString() };
    await saveReadonlyLearnSession(project.rootPath, analyzing, "DRAFT");
    active = { root: project.rootPath, session: analyzing };
    let result: Extract<ReadonlyLearnSession, { status: "RESULT_READY" }>["result"];
    let threadId: string;
    if (body.mode === "ASSIMILATION") {
      const detection = await detectProject(project.rootPath);
      const agent = process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1" ? { async run<T>() { const scan = await createScanAgent().run({ workingDirectory: staging!, prompt: "Fixture direction" }); return { threadId: "fake-assimilation-thread", structured: { summary: "Combine grounded principles while preserving product identity.", sourceMap: analyses.map((analysis) => ({ referenceIds: analysis.referenceIds, role: "Product-fit evidence", principles: analysis.keep })), direction: scan.structured } as T }; } } : new CodexAgent();
      const outcome = await assimilateReferences({ analyses, analysisWorkingDirectory: staging, projectContext: { name: project.name, routes: detection.routes } }, { agent, createId: randomUUID });
      threadId = outcome.threadId;
      result = { summary: outcome.summary, sourceMap: outcome.sourceMap, proposedDirection: outcome.proposedDirection };
    } else {
      const agent = process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1" ? { async run<T>() { return { threadId: "fake-verify-thread", structured: { summary: "Design direction review", findings: [{ severity: "IMPORTANT", principle: "Preserve stable navigation", observation: "The supplied direction introduces a navigation change.", recommendation: "Require a human decision before changing navigation." }] } as T }; } } : new CodexAgent();
      const outcome = await verifyDesignDirection({ intendedDirection: draft.intendedDirection!, currentDirection: draft.currentDirection!, analysisWorkingDirectory: staging }, { agent });
      threadId = outcome.threadId;
      result = { summary: outcome.summary, findings: outcome.findings, evidenceScope: outcome.evidenceScope };
    }
    const session: ReadonlyLearnSession = { ...draft, status: "RESULT_READY", updatedAt: new Date().toISOString(), result, agentThreadId: threadId };
    await saveReadonlyLearnSession(project.rootPath, session, "ANALYZING");
    return Response.json({ session });
  } catch {
    if (active !== undefined) await saveReadonlyLearnSession(active.root, { ...active.session, status: "ANALYZING", error: "Readonly analysis did not complete.", updatedAt: new Date().toISOString() }).catch(() => undefined);
    return Response.json({ error: "Readonly analysis could not be completed or persisted." }, { status: 422 });
  } finally { if (staging !== undefined) await rm(staging, { recursive: true, force: true }).catch(() => undefined); }
}
