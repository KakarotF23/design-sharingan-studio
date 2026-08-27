import { decideMangekyoGate } from "../../../../../../features/execute/mangekyo-server";
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
    Object.keys(body).length !== 2 ||
    !safeId((body as Record<string, unknown>).sessionId) ||
    !["REJECT", "APPROVE_ONCE", "EXPAND_SCOPE"].includes(
      (body as Record<string, unknown>).decision as string,
    )
  ) {
    return Response.json({ error: "Choose an exact Human Gate decision." }, { status: 400 });
  }
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    const { references, session } = await decideMangekyoGate(
      project,
      (body as { sessionId: string }).sessionId,
      (body as { decision: "REJECT" | "APPROVE_ONCE" | "EXPAND_SCOPE" }).decision,
    );
    return Response.json(mangekyoDataView(references, session));
  } catch {
    return Response.json(
      { error: "The Human Gate decision could not be safely applied." },
      { status: 422 },
    );
  }
}
