import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commitFeatureEvolveResult,
  detectProject,
  loadReference,
  loadReferenceDesignDNA,
  saveSession,
  transitionLearnSession,
} from "@design-sharingan/project-adapters";
import type {
  FeatureEvolvePendingSession,
  FeatureEvolveResultSession,
} from "@design-sharingan/project-adapters";
import { evolveFeature } from "@design-sharingan/sharingan-engine";
import { createEvolveAgent } from "../../../../../features/learn/evolve-agent";
import { parseFeatureBrief } from "../../../../../features/learn/feature-brief";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { createAnalysisStagingDirectory } from "../../../../../features/projects/project-locator";
import { readProjectJson } from "../../../../../features/projects/project-request";

export const runtime = "nodejs";

function objectBody(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function referenceIds(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > 10 ||
    !value.every(
      (entry) =>
        typeof entry === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(entry),
    ) ||
    new Set(value).size !== value.length
  ) {
    return undefined;
  }
  return value;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const parsed = await readProjectJson(request);
  if (!parsed.ok) return parsed.response;
  if (!objectBody(parsed.body)) {
    return Response.json({ error: "Create a valid Feature Brief." }, { status: 400 });
  }
  const featureBrief = parseFeatureBrief(parsed.body.featureBrief);
  const selectedReferenceIds = referenceIds(parsed.body.referenceIds);
  if (featureBrief === undefined || selectedReferenceIds === undefined) {
    return Response.json({ error: "Create a valid Feature Brief." }, { status: 400 });
  }

  const { projectId } = await context.params;
  let stagingPath: string | undefined;
  let activeProjectRoot: string | undefined;
  let analyzingSession: FeatureEvolvePendingSession | undefined;
  let resultPersisted = false;
  try {
    const project = await resolveProjectRequest(projectId);
    activeProjectRoot = project.rootPath;
    const [detection, analyses] = await Promise.all([
      detectProject(project.rootPath),
      Promise.all(
        selectedReferenceIds.map(async (referenceId) => {
          const reference = await loadReference(
            project.rootPath,
            project.id,
            referenceId,
          );
          if (reference.analysisStatus !== "ANALYZED") {
            throw new Error("Selected reference has no analysis evidence");
          }
          const designDNA = await loadReferenceDesignDNA(
            project.rootPath,
            project.id,
            referenceId,
          );
          if (
            designDNA.referenceIds.length !== 1 ||
            designDNA.referenceIds[0] !== referenceId
          ) {
            throw new Error("Selected reference provenance is invalid");
          }
          return designDNA;
        }),
      ),
    ]);
    const projectContext = {
      name: project.name,
      framework: detection.framework,
      routes: [...detection.routes],
      componentDirectories: [...detection.componentDirectories],
      designDocuments: [...detection.designDocuments],
    };
    const analysisPath = await createAnalysisStagingDirectory(project.rootPath);
    stagingPath = analysisPath;
    await writeFile(
      /* turbopackIgnore: true */ join(analysisPath, "project-context.json"),
      `${JSON.stringify(projectContext, null, 2)}\n`,
      { mode: 0o600 },
    );

    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const draftSession: FeatureEvolvePendingSession = {
      id: sessionId,
      projectId: project.id,
      type: "FEATURE_EVOLVE",
      status: "DRAFT",
      createdAt,
      updatedAt: createdAt,
      featureBrief,
      referenceIds: selectedReferenceIds,
    };
    await saveSession(project.rootPath, draftSession);
    analyzingSession = {
      ...draftSession,
      status: "ANALYZING",
      updatedAt: new Date().toISOString(),
    };
    await transitionLearnSession(project.rootPath, "DRAFT", analyzingSession);

    const evolved = await evolveFeature(
      {
        featureBrief,
        referenceAnalyses: analyses,
        analysisWorkingDirectory: analysisPath,
        projectContext,
      },
      { agent: createEvolveAgent() },
    );
    const resultSession: FeatureEvolveResultSession = {
      ...draftSession,
      status: "RESULT_READY",
      updatedAt: new Date().toISOString(),
      uxImpact: evolved.uxImpact,
      approaches: evolved.approaches,
      agentThreadId: evolved.threadId,
    };
    await commitFeatureEvolveResult(project.rootPath, resultSession);
    resultPersisted = true;
    const awaitingSession: FeatureEvolveResultSession = {
      ...resultSession,
      status: "AWAITING_DECISION",
      updatedAt: new Date().toISOString(),
    };
    await transitionLearnSession(
      project.rootPath,
      "RESULT_READY",
      awaitingSession,
    );
    return Response.json({ session: awaitingSession });
  } catch {
    if (
      !resultPersisted &&
      activeProjectRoot !== undefined &&
      analyzingSession !== undefined
    ) {
      const failedSession: FeatureEvolvePendingSession = {
        ...analyzingSession,
        error: "Feature EVOLVE did not complete.",
        updatedAt: new Date().toISOString(),
      };
      await saveSession(activeProjectRoot, failedSession).catch(() => undefined);
    }
    return Response.json(
      { error: "Feature EVOLVE could not be completed or persisted." },
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
