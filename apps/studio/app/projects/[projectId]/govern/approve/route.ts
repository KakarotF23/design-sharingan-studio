import { approveProjectGenome } from "../../../../../features/govern/govern-server";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { readProjectJson } from "../../../../../features/projects/project-request";

export const runtime = "nodejs";

function approvalBody(value: unknown): value is {
  expectedRevision: number;
  expectedPayloadHash: string;
  acceptedClaimId: string;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    Object.keys(value).every((key) => ["expectedRevision", "expectedPayloadHash", "acceptedClaimId"].includes(key)) &&
    Object.hasOwn(value, "expectedRevision") &&
    Object.hasOwn(value, "expectedPayloadHash") &&
    Object.hasOwn(value, "acceptedClaimId") &&
    Number.isSafeInteger((value as { expectedRevision?: unknown }).expectedRevision) &&
    ((value as { expectedRevision: number }).expectedRevision >= 1) &&
    typeof (value as { expectedPayloadHash?: unknown }).expectedPayloadHash === "string" &&
    /^[a-f0-9]{64}$/.test((value as { expectedPayloadHash: string }).expectedPayloadHash) &&
    typeof (value as { acceptedClaimId?: unknown }).acceptedClaimId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test((value as { acceptedClaimId: string }).acceptedClaimId)
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
      await approveProjectGenome(
        project,
        parsed.body.expectedRevision,
        parsed.body.expectedPayloadHash,
        parsed.body.acceptedClaimId,
      ),
    );
  } catch {
    return Response.json(
      { error: "Genome approval could not be recorded. Reload current governance first." },
      { status: 409 },
    );
  }
}
