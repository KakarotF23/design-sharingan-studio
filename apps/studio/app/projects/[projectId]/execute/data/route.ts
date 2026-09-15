import { recoverInterruptedSafeExecution } from "@design-sharingan/project-adapters";
import { inspectMutationRecovery } from "@design-sharingan/approval-engine";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    const executeSession = await recoverInterruptedSafeExecution(
      project.rootPath,
      project.id,
      () => inspectMutationRecovery(project.rootPath),
    );
    return Response.json({ executeSession });
  } catch {
    return Response.json(
      { error: "Approved execution direction is unavailable." },
      { status: 404 },
    );
  }
}
