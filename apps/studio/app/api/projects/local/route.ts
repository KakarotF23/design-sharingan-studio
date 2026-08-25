import { isAbsolute } from "node:path";
import { LocalProjectAdapter } from "@design-sharingan/project-adapters";
import type { StudioProjectState } from "../../../../features/projects/project-state";

export const runtime = "nodejs";

function bodyObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectResponse(project: StudioProjectState): Response {
  return Response.json({ project });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send a valid JSON request." }, { status: 400 });
  }

  if (!bodyObject(body) || typeof body.rootPath !== "string") {
    return Response.json(
      { error: "An absolute project folder path is required." },
      { status: 400 },
    );
  }

  const rootPath = body.rootPath.trim();
  if (
    rootPath.length === 0 ||
    rootPath.length > 4096 ||
    rootPath.includes("\0") ||
    !isAbsolute(rootPath)
  ) {
    return Response.json(
      { error: "Enter a valid absolute project folder path." },
      { status: 400 },
    );
  }

  try {
    const workspace = await new LocalProjectAdapter().open(rootPath);
    return projectResponse({
      id: workspace.id,
      name: workspace.name,
      sourceType: workspace.sourceType,
      status: workspace.status,
      framework: workspace.framework,
      packageManager: workspace.packageManager,
      devCommand: workspace.devCommand,
      capabilities: workspace.capabilities,
    });
  } catch {
    return Response.json(
      {
        error:
          "Project folder could not be opened. Confirm the path exists and is readable, then try again.",
      },
      { status: 422 },
    );
  }
}
