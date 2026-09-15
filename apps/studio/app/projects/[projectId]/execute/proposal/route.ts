import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateChangeProposal } from "@design-sharingan/approval-engine";
import {
  detectProject,
  prepareSafeExecutionProposal,
} from "@design-sharingan/project-adapters";
import { createSafeProposalAgent } from "../../../../../features/execute/safe-mode-agent";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { createAnalysisStagingDirectory } from "../../../../../features/projects/project-locator";
import { readProjectJson } from "../../../../../features/projects/project-request";

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
  let analysisPath: string | undefined;
  try {
    const project = await resolveProjectRequest(projectId);
    const detection = await detectProject(project.rootPath);
    analysisPath = await createAnalysisStagingDirectory(project.rootPath);
    const projectContext = {
      name: project.name,
      framework: detection.framework,
      routes: [...detection.routes],
      componentDirectories: [...detection.componentDirectories],
    };
    await writeFile(
      /* turbopackIgnore: true */ join(analysisPath, "project-context.json"),
      `${JSON.stringify(projectContext, null, 2)}\n`,
      { mode: 0o600 },
    );
    const session = await prepareSafeExecutionProposal(
      project.rootPath,
      project.id,
      sessionId,
      async (source) =>
        generateChangeProposal(
          {
            sessionId: source.id,
            designApproach: source.designApproach,
            featureBrief: source.featureBrief,
            analysisWorkingDirectory: analysisPath as string,
            projectContext,
            ...(source.revisionRequest === undefined
              ? {}
              : { revisionRequest: source.revisionRequest }),
            ...(source.previousProposalThreadId === undefined
              ? {}
              : { threadId: source.previousProposalThreadId }),
          },
          { agent: createSafeProposalAgent(), createId: randomUUID },
        ),
    );
    return Response.json({ session });
  } catch {
    return Response.json(
      { error: "The Safe Mode proposal could not be prepared." },
      { status: 422 },
    );
  } finally {
    if (analysisPath !== undefined) {
      await rm(/* turbopackIgnore: true */ analysisPath, {
        force: true,
        recursive: true,
      }).catch(() => undefined);
    }
  }
}
