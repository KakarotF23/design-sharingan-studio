import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubProjectAdapter,
  isValidGitHubRepositoryUrl,
} from "@design-sharingan/project-adapters";
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

export async function POST(request: Request): Promise<Response> {
  const intake = await readIntakeJson(request);
  if (!intake.ok) return intake.response;
  const body = intake.body;

  if (
    !bodyObject(body) ||
    typeof body.repositoryUrl !== "string" ||
    typeof body.branch !== "string" ||
    (body.token !== undefined && typeof body.token !== "string")
  ) {
    return Response.json(
      { error: "Repository URL and branch are required." },
      { status: 400 },
    );
  }

  const repositoryUrl = body.repositoryUrl.trim();
  const branch = body.branch.trim();
  const token = typeof body.token === "string" ? body.token : undefined;
  if (
    !isValidGitHubRepositoryUrl(repositoryUrl) ||
    repositoryUrl.length > 2048 ||
    branch.length === 0 ||
    branch.length > 255 ||
    /[\0\r\n]/.test(branch) ||
    (token?.length ?? 0) > 8192
  ) {
    return Response.json(
      { error: "Enter a valid GitHub HTTPS URL, branch, and optional token." },
      { status: 400 },
    );
  }

  try {
    const importRoot =
      process.env.DESIGN_SHARINGAN_IMPORT_ROOT ??
      join(tmpdir(), "design-sharingan-studio-imports");
    await mkdir(importRoot, { recursive: true });
    const workspace = await new GitHubProjectAdapter().open({
      repositoryUrl,
      branch,
      token,
      destinationPath: join(importRoot, "repository"),
    });
    const project: StudioProjectState = {
      id: workspace.id,
      name: workspace.name,
      sourceType: workspace.sourceType,
      status: workspace.status,
      framework: workspace.framework,
      packageManager: workspace.packageManager,
      devCommand: workspace.devCommand,
      capabilities: workspace.capabilities,
    };
    const response = NextResponse.json({ project });
    response.cookies.set(
      PROJECT_LOCATOR_COOKIE,
      encodeProjectLocator(workspace.rootPath),
      {
        httpOnly: true,
        sameSite: "strict",
        path: `/projects/${encodeURIComponent(project.id)}`,
        priority: "high",
      },
    );
    return response;
  } catch {
    return Response.json(
      {
        error:
          "Repository could not be imported. Confirm access, URL, and branch, then try again.",
      },
      { status: 422 },
    );
  }
}
