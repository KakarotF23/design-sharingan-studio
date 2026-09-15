import { auditProjectDrift } from "../../../../../features/govern/govern-server";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { readProjectJson } from "../../../../../features/projects/project-request";

export const runtime = "nodejs";

function emptyObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const parsed = await readProjectJson(request);
  if (!parsed.ok) return parsed.response;
  if (!emptyObject(parsed.body)) {
    return Response.json({ error: "Drift audit request is invalid." }, { status: 400 });
  }
  const { projectId } = await context.params;
  try {
    return Response.json(await auditProjectDrift(await resolveProjectRequest(projectId)));
  } catch {
    return Response.json(
      { error: "Drift evidence could not be authenticated for this project." },
      { status: 422 },
    );
  }
}
