import { startMangekyoLoop } from "../../../../../../features/execute/mangekyo-server";
import { mangekyoDataView } from "../../../../../../features/execute/mangekyo-view";
import { resolveProjectRequest } from "../../../../../../features/projects/project-access";
import { readProjectJson } from "../../../../../../features/projects/project-request";

export const runtime = "nodejs";

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const parsed = await readProjectJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !safeId((body as Record<string, unknown>).safeSessionId)
  ) {
    return Response.json({ error: "Select the exact approved execution session." }, { status: 400 });
  }
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    const { references, session } = await startMangekyoLoop(
      project,
      (body as { safeSessionId: string }).safeSessionId,
    );
    return Response.json(mangekyoDataView(references, session));
  } catch {
    return Response.json(
      { error: "The Mangekyō loop could not establish truthful visual evidence." },
      { status: 422 },
    );
  }
}
