import { randomUUID } from "node:crypto";
import type { Approval } from "@design-sharingan/core";
import {
  approveFeatureEvolveApproach,
  isFeatureEvolveResultSession,
  loadSession,
} from "@design-sharingan/project-adapters";
import type {
  FeatureEvolveApprovedSession,
  SafeExecutionDraftSession,
} from "@design-sharingan/project-adapters";
import { resolveProjectRequest } from "../../../../../../features/projects/project-access";
import { readProjectJson } from "../../../../../../features/projects/project-request";

export const runtime = "nodejs";

function objectBody(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
    !objectBody(parsed.body) ||
    !safeId(parsed.body.sessionId) ||
    !safeId(parsed.body.approachId) ||
    !(
      parsed.body.comment === undefined ||
      (typeof parsed.body.comment === "string" &&
        parsed.body.comment.length <= 2_000)
    )
  ) {
    return Response.json({ error: "Select a valid design approach." }, { status: 400 });
  }
  const sessionId = parsed.body.sessionId;
  const approachId = parsed.body.approachId;
  const comment = parsed.body.comment;

  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    const existing = await loadSession(
      project.rootPath,
      project.id,
      sessionId,
    );
    if (
      !isFeatureEvolveResultSession(existing) ||
      existing.status !== "AWAITING_DECISION"
    ) {
      return Response.json(
        { error: "This design direction is not awaiting approval." },
        { status: 409 },
      );
    }
    const approach = existing.approaches.find(
      (entry) => entry.id === approachId,
    );
    if (approach === undefined) {
      return Response.json({ error: "Select a valid design approach." }, { status: 400 });
    }

    const timestamp = new Date().toISOString();
    const approval: Approval = {
      id: randomUUID(),
      proposalId: approach.id,
      decision: "APPROVED",
      scope: "DESIGN_APPROACH",
      approvedBy: "local-user",
      ...(comment?.trim()
        ? { comment: comment.trim() }
        : {}),
      createdAt: timestamp,
    };
    const executeSessionId = randomUUID();
    const approvedSession: FeatureEvolveApprovedSession = {
      ...existing,
      status: "APPROVED",
      updatedAt: timestamp,
      approvedApproachId: approach.id,
      approval,
      executeSessionId,
    };
    const executeSession: SafeExecutionDraftSession = {
      id: executeSessionId,
      projectId: project.id,
      type: "SAFE_EXECUTION",
      status: "IDLE",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceSessionId: existing.id,
      approvedApproachId: approach.id,
      approvalId: approval.id,
      featureBrief: existing.featureBrief,
      designApproach: approach,
    };
    await approveFeatureEvolveApproach(project.rootPath, {
      session: approvedSession,
      approval,
      executeSession,
    });
    return Response.json({ executeSession });
  } catch {
    return Response.json(
      { error: "The design approach could not be approved." },
      { status: 422 },
    );
  }
}
