import { randomUUID } from "node:crypto";
import type { Approval } from "@design-sharingan/core";
import { MutationExecutor } from "@design-sharingan/approval-engine";
import {
  approveAndExecuteSafeProposal,
  loadSafeExecutionState,
} from "@design-sharingan/project-adapters";
import { createSafeMutationAgent } from "../../../../../../features/execute/safe-mode-agent";
import { verifyApprovedSafeMutation } from "../../../../../../features/execute/safe-verification-server";
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
  const body = parsed.body as Record<string, unknown> | null;
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !safeId(body.sessionId)
  ) {
    return Response.json({ error: "Select a valid execution session." }, { status: 400 });
  }
  const sessionId = body.sessionId;
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    const waiting = await loadSafeExecutionState(project.rootPath, project.id);
    if (waiting.id !== sessionId || waiting.status !== "WAITING_APPROVAL") {
      return Response.json(
        { error: "This proposal is not waiting for approval." },
        { status: 409 },
      );
    }
    const timestamp = new Date().toISOString();
    const approval: Approval = {
      id: randomUUID(),
      proposalId: waiting.proposal.id,
      decision: "APPROVED",
      scope: "CHANGE_PROPOSAL",
      approvedBy: "local-user",
      createdAt: timestamp,
    };
    const session = await approveAndExecuteSafeProposal(
      project.rootPath,
      project.id,
      waiting.id,
      approval,
      async (approved) =>
        new MutationExecutor({
          workspaceRoot: project.rootPath,
          proposalThreadId: approved.proposalThreadId,
          agent: createSafeMutationAgent(),
        }).apply({ proposal: approved.proposal, approval }),
    );
    return Response.json({ session: await verifyApprovedSafeMutation(project, session.id) });
  } catch {
    return Response.json(
      { error: "The approved mutation could not be applied safely." },
      { status: 422 },
    );
  }
}
