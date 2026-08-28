import { stopMangekyoLoop } from "../../../../../../features/execute/mangekyo-server";
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
    !safeId((body as Record<string, unknown>).sessionId)
  ) {
    return Response.json({ error: "Select the exact active visual loop." }, { status: 400 });
  }
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    const { references, session } = await stopMangekyoLoop(
      project,
      (body as { sessionId: string }).sessionId,
    );
    return Response.json(mangekyoDataView(references, session));
  } catch {
    return Response.json(
      { error: "The visual loop could not be stopped from exact durable evidence." },
      { status: 422 },
    );
  }
}
