import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectProject, loadReference, loadReferenceImage, saveReferenceDesignDNA, saveSession, updateReference } from "@design-sharingan/project-adapters";
import { scanReference } from "@design-sharingan/sharingan-engine";
import { createScanAgent } from "../../../../../features/learn/scan-agent";
import type { ReferenceScanSession } from "../../../../../features/references/reference-types";
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
  try {
    const project = await resolveProjectRequest(projectId);
    const [reference, image, detection] = await Promise.all([
      loadReference(project.rootPath, project.id, body.referenceId),
      loadReferenceImage(project.rootPath, project.id, body.referenceId),
      detectProject(project.rootPath),
    ]);
    stagingPath = await createAnalysisStagingDirectory();
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
        persist: async (designDNA) => {
          await saveReferenceDesignDNA(
            project.rootPath,
            project.id,
            reference.id,
            designDNA,
          );
        },
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
    await updateReference(project.rootPath, updatedReference);
    const session: ReferenceScanSession = {
      id: randomUUID(),
      projectId: project.id,
      type: "REFERENCE_SCAN",
      status: "RESULT_READY",
      createdAt: timestamp,
      updatedAt: timestamp,
      referenceId: reference.id,
      referenceTitle: reference.title,
      designDNA: result.designDNA,
      agentThreadId: result.threadId,
    };
    await saveSession(project.rootPath, session);
    return Response.json({ designDNA: result.designDNA, session });
  } catch {
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
