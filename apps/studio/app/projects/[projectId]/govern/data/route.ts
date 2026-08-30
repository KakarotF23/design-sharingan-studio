import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { loadGovernanceProjection } from "../../../../../features/govern/govern-server";
import { isSameOriginRequest } from "../../../../../app/api/projects/intake-request";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Governance request was rejected." }, { status: 403 });
  }
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
