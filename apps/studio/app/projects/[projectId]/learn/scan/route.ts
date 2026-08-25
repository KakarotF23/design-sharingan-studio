import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commitReferenceScan,
  detectProject,
  loadReference,
  loadReferenceImage,
  saveSession,
  transitionLearnSession,
} from "@design-sharingan/project-adapters";
import type { ReferenceScanResultSession } from "@design-sharingan/project-adapters";
import { scanReference } from "@design-sharingan/sharingan-engine";
import { createScanAgent } from "../../../../../features/learn/scan-agent";
import type { ReferenceScanPendingSession } from "../../../../../features/references/reference-types";
import { createAnalysisStagingDirectory } from "../../../../../features/projects/project-locator";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { readProjectJson } from "../../../../../features/projects/project-request";

export const runtime = "nodejs";

function objectBody(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalBoundedString(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function noteList(value: string | undefined): string[] {
  const normalized = value?.trim();
  return normalized ? [normalized] : [];
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const parsed = await readProjectJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (
    !objectBody(body) ||
    typeof body.referenceId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(body.referenceId) ||
    !optionalBoundedString(body.likes, 2_000) ||
    !optionalBoundedString(body.dislikes, 2_000) ||
    !optionalBoundedString(body.notes, 4_000) ||
    typeof body.analyzeForMe !== "boolean"
  ) {
    return Response.json({ error: "Select a valid reference and analysis intent." }, { status: 400 });
  }

  const { projectId } = await context.params;
  let stagingPath: string | undefined;
  let activeProjectRoot: string | undefined;
  let analyzingSession: ReferenceScanPendingSession | undefined;
  try {
    const project = await resolveProjectRequest(projectId);
    activeProjectRoot = project.rootPath;
    const [reference, image, detection] = await Promise.all([
      loadReference(project.rootPath, project.id, body.referenceId),
      loadReferenceImage(project.rootPath, project.id, body.referenceId),
      detectProject(project.rootPath),
    ]);
    stagingPath = await createAnalysisStagingDirectory(project.rootPath);
    const extension =
      image.type === "image/png"
        ? ".png"
        : image.type === "image/jpeg"
          ? ".jpg"
          : image.type === "image/webp"
            ? ".webp"
            : ".gif";
    const stagedImagePath = join(stagingPath, `reference${extension}`);
    await writeFile(/* turbopackIgnore: true */ stagedImagePath, image.bytes, {
      mode: 0o600,
    });

    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const draftSession: ReferenceScanPendingSession = {
      id: sessionId,
      projectId: project.id,
      type: "REFERENCE_SCAN",
      status: "DRAFT",
      createdAt,
      updatedAt: createdAt,
      referenceId: reference.id,
      referenceTitle: reference.title,
    };
    await saveSession(project.rootPath, draftSession);
    analyzingSession = {
      ...draftSession,
      status: "ANALYZING",
      updatedAt: new Date().toISOString(),
    };
    await transitionLearnSession(
      project.rootPath,
      "DRAFT",
      analyzingSession,
    );

    const result = await scanReference(
      {
        reference: {
          ...reference,
          likes: noteList(body.likes),
          dislikes: noteList(body.dislikes),
        },
        stagedImagePath,
        analysisWorkingDirectory: stagingPath,
        projectContext: {
          name: project.name,
          framework: detection.framework,
          routes: detection.routes,
          componentDirectories: detection.componentDirectories,
          designDocuments: detection.designDocuments,
        },
        notes: body.notes,
        analyzeForMe: body.analyzeForMe,
      },
      {
        agent: createScanAgent(),
        createId: randomUUID,
        persist: async () => undefined,
      },
    );
    const timestamp = new Date().toISOString();
    const updatedReference = {
      ...reference,
      likes: noteList(body.likes),
      dislikes: noteList(body.dislikes),
      notes: body.notes?.trim() || reference.notes,
      analysisStatus: "ANALYZED" as const,
    };
    const session: ReferenceScanResultSession = {
      id: sessionId,
      projectId: project.id,
      type: "REFERENCE_SCAN",
      status: "RESULT_READY",
      createdAt: draftSession.createdAt,
      updatedAt: timestamp,
      referenceId: reference.id,
      referenceTitle: reference.title,
      designDNA: result.designDNA,
      agentThreadId: result.threadId,
    };
    await commitReferenceScan(project.rootPath, {
      reference: updatedReference,
      designDNA: result.designDNA,
      session,
    });
    return Response.json({ designDNA: result.designDNA, session });
  } catch {
    if (activeProjectRoot !== undefined && analyzingSession !== undefined) {
      const failedSession: ReferenceScanPendingSession = {
        ...analyzingSession,
        error: "Reference analysis did not complete.",
        updatedAt: new Date().toISOString(),
      };
      await saveSession(activeProjectRoot, failedSession).catch(() => undefined);
    }
    return Response.json(
      { error: "Reference analysis could not be completed or persisted." },
      { status: 422 },
    );
  } finally {
    if (stagingPath !== undefined) {
      await rm(/* turbopackIgnore: true */ stagingPath, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }
}
