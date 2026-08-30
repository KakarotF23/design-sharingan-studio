import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { loadGovernanceProjection } from "../../../../../features/govern/govern-server";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    return Response.json(await loadGovernanceProjection(project));
  } catch {
    return Response.json(
      { error: "Governance evidence is unavailable or unsafe." },
      { status: 422 },
    );
  }
}
