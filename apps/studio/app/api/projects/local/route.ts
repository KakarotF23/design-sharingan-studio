import { isAbsolute } from "node:path";
import { LocalProjectAdapter } from "@design-sharingan/project-adapters";
import { NextResponse } from "next/server";
import {
  encodeProjectLocator,
  PROJECT_LOCATOR_COOKIE,
} from "../../../../features/projects/project-locator";
import type { StudioProjectState } from "../../../../features/projects/project-state";
import { readIntakeJson } from "../intake-request";

export const runtime = "nodejs";

function bodyObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectResponse(
  project: StudioProjectState,
  rootPath: string,
): Response {
  const response = NextResponse.json({ project });
  response.cookies.set(PROJECT_LOCATOR_COOKIE, encodeProjectLocator(rootPath), {
    httpOnly: true,
    sameSite: "strict",
    path: `/projects/${encodeURIComponent(project.id)}`,
    priority: "high",
  });
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const intake = await readIntakeJson(request);
  if (!intake.ok) return intake.response;
  const body = intake.body;

  if (!bodyObject(body) || typeof body.rootPath !== "string") {
    return Response.json(
      { error: "An absolute project folder path is required." },
      { status: 400 },
    );
  }

  const rootPath = body.rootPath.trim();
  if (
    rootPath.length === 0 ||
    rootPath.length > 2048 ||
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
    return projectResponse(
      {
        id: workspace.id,
        name: workspace.name,
        sourceType: workspace.sourceType,
        status: workspace.status,
        framework: workspace.framework,
        packageManager: workspace.packageManager,
        devCommand: workspace.devCommand,
        capabilities: workspace.capabilities,
      },
      workspace.rootPath,
    );
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
