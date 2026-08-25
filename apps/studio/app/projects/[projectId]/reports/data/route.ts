import { listSessions } from "@design-sharingan/project-adapters";
import type { ReferenceScanSession } from "../../../../../features/references/reference-types";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    const sessions = await listSessions<ReferenceScanSession>(
      project.rootPath,
      project.id,
    );
    return Response.json({ sessions });
  } catch {
    return Response.json({ error: "Project reports are unavailable." }, { status: 404 });
  }
}
