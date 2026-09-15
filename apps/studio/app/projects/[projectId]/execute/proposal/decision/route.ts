import { randomUUID } from "node:crypto";
import type { Approval } from "@design-sharingan/core";
import {
  decideSafeExecutionProposal,
  loadSafeExecutionState,
} from "@design-sharingan/project-adapters";
import { resolveProjectRequest } from "../../../../../../features/projects/project-access";
import { readProjectJson } from "../../../../../../features/projects/project-request";

export const runtime = "nodejs";

function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const parsed = await readProjectJson(request);
  if (!parsed.ok) return parsed.response;
  if (
    parsed.body === null ||
    typeof parsed.body !== "object" ||
    Array.isArray(parsed.body)
  ) {
    return Response.json({ error: "Choose a valid proposal decision." }, { status: 400 });
  }
  const body = parsed.body as Record<string, unknown>;
  const allowedKeys = ["sessionId", "decision", "comment"];
  if (
    Object.keys(body).some((key) => !allowedKeys.includes(key)) ||
    Object.keys(body).length < 2 ||
    Object.keys(body).length > 3 ||
    !safeId(body.sessionId) ||
    (body.decision !== "REVISION_REQUESTED" && body.decision !== "REJECTED") ||
    (body.decision === "REVISION_REQUESTED" &&
      (typeof body.comment !== "string" || body.comment.trim().length === 0)) ||
    (body.comment !== undefined &&
      (typeof body.comment !== "string" || body.comment.length > 2_000))
  ) {
    return Response.json({ error: "Choose a valid proposal decision." }, { status: 400 });
  }
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    const waiting = await loadSafeExecutionState(project.rootPath, project.id);
    if (waiting.id !== body.sessionId || waiting.status !== "WAITING_APPROVAL") {
      return Response.json(
        { error: "This proposal is not waiting for a decision." },
        { status: 409 },
      );
    }
    const approval: Approval = {
      id: randomUUID(),
      proposalId: waiting.proposal.id,
      decision: body.decision,
      scope: "CHANGE_PROPOSAL",
      approvedBy: "local-user",
      ...(typeof body.comment === "string" && body.comment.trim()
        ? { comment: body.comment.trim() }
        : {}),
      createdAt: new Date().toISOString(),
    };
    const session = await decideSafeExecutionProposal(
      project.rootPath,
      project.id,
      waiting.id,
      approval,
    );
    return Response.json({ session });
  } catch {
    return Response.json(
      { error: "The proposal decision could not be persisted." },
      { status: 422 },
    );
  }
}
