import { loadProjectReport } from "@design-sharingan/project-adapters";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    const query = new URL(request.url).searchParams;
    const offset = query.get("offset") ?? "0";
    const limit = query.get("limit") ?? "25";
    if (!/^\d+$/.test(offset) || !/^\d+$/.test(limit)) {
      throw new Error("Report pagination is invalid");
    }
    const project = await resolveProjectRequest(projectId);
    return Response.json(await loadProjectReport(project.rootPath, project.id, {
      offset: Number(offset),
      limit: Number(limit),
    }));
  } catch {
    return Response.json({ error: "Project reports are unavailable." }, { status: 404 });
  }
}
