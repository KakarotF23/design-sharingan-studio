import { loadMangekyoContext } from "../../../../../../features/execute/mangekyo-server";
import { mangekyoDataView } from "../../../../../../features/execute/mangekyo-view";
import { resolveProjectRequest } from "../../../../../../features/projects/project-access";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    const { references, session } = await loadMangekyoContext(project);
    return Response.json(mangekyoDataView(references, session));
  } catch {
    return Response.json(
      { error: "Mangekyō evidence is unavailable or ambiguous." },
      { status: 404 },
    );
  }
}
