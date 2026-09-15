import { listReferences, loadProjectReport } from "@design-sharingan/project-adapters";
import { authenticateGovernanceReportSession, loadGovernanceProjection } from "@design-sharingan/eternal-engine";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const project = await resolveProjectRequest((await context.params).projectId);
    const [references, report, governance] = await Promise.all([
      listReferences(project.rootPath, project.id),
      loadProjectReport(project.rootPath, project.id, { offset: 0, limit: 10 }, { authenticateGovernanceSession: (_root, _id, session) => authenticateGovernanceReportSession(project, session) }),
      loadGovernanceProjection(project),
    ]);
    return Response.json({ referenceCount: references.length, report, governance });
  } catch { return Response.json({ error: "Saved project evidence could not be authenticated. Open Reports or Govern to inspect it; no health status is assumed." }, { status: 409 }); }
}
