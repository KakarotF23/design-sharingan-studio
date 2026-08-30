import { approveProjectGenome } from "../../../../../features/govern/govern-server";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { readProjectJson } from "../../../../../features/projects/project-request";

export const runtime = "nodejs";

function approvalBody(value: unknown): value is { expectedRevision: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "expectedRevision") &&
    Number.isSafeInteger((value as { expectedRevision?: unknown }).expectedRevision) &&
    ((value as { expectedRevision: number }).expectedRevision >= 1)
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const parsed = await readProjectJson(request);
  if (!parsed.ok) return parsed.response;
  if (!approvalBody(parsed.body)) {
    return Response.json({ error: "Genome approval request is invalid." }, { status: 400 });
  }
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    return Response.json(
      await approveProjectGenome(project, parsed.body.expectedRevision),
    );
  } catch {
    return Response.json(
      { error: "Genome approval could not be recorded. Reload current governance first." },
      { status: 409 },
    );
  }
}
