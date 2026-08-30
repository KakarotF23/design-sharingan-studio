import { initializeProjectGovernance } from "../../../../../features/govern/govern-server";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { readProjectJson } from "../../../../../features/projects/project-request";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const parsed = await readProjectJson(request);
  if (!parsed.ok) return parsed.response;
  if (
    parsed.body === null ||
    typeof parsed.body !== "object" ||
    Array.isArray(parsed.body) ||
    Object.keys(parsed.body).length !== 0
  ) {
    return Response.json({ error: "Genome initialization request is invalid." }, { status: 400 });
  }
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    return Response.json(await initializeProjectGovernance(project));
  } catch {
    return Response.json(
      { error: "Draft Genome could not be initialized from authenticated evidence." },
      { status: 422 },
    );
  }
}
