import { CodexAgent } from "@design-sharingan/agent-runtime";
import { captureProjectGovernance, type GovernCaptureScope } from "@design-sharingan/eternal-engine";
import type { VisualAnalysisWireOutput } from "@design-sharingan/visual-engine";
import { createAnalysisStagingDirectory } from "../../../../../features/projects/project-locator";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { readProjectJson } from "../../../../../features/projects/project-request";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const parsed = await readProjectJson(request); if (!parsed.ok) return parsed.response;
  const body = parsed.body as GovernCaptureScope;
  if (!body || !["SELECTED_SCREENS", "WHOLE_APP"].includes(body.requestedScope) || !Array.isArray(body.expectedScope) || Object.keys(body).length !== 2) return Response.json({ error: "Choose an explicit screen/state scope." }, { status: 400 });
  try {
    const pass = { status: "PASS" as const, evidence: ["The actual scoped fixture render preserves the authenticated approved Genome."] };
    const output: VisualAnalysisWireOutput = { verification: { uxIntegrity: pass, productConsistency: pass, accessibility: pass, genomeIntegrity: pass }, findings: [] };
    const agent = process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1" ? { async run<T>() { return { threadId: "fake-governed-capture", structured: output as T, finalResponse: JSON.stringify(output), items: [] }; } } : new CodexAgent();
    return Response.json(await captureProjectGovernance(await resolveProjectRequest((await context.params).projectId), body, { createAnalysisStagingDirectory, agent }));
  } catch { return Response.json({ error: "Governed capture could not establish authenticated evidence for that scope." }, { status: 422 }); }
}
