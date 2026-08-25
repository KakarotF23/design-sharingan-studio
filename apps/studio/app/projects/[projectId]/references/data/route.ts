import { randomUUID } from "node:crypto";
import type { Reference } from "@design-sharingan/core";
import {
  listReferences,
  saveReferenceArtifact,
} from "@design-sharingan/project-adapters";
import { referenceView } from "../../../../../features/references/reference-types";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { readProjectMultipart } from "../../../../../features/projects/project-request";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    const references = await listReferences(project.rootPath, project.id);
    return Response.json({ references: references.map(referenceView) });
  } catch {
    return Response.json({ error: "Project references are unavailable." }, { status: 404 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const parsed = await readProjectMultipart(request);
  if (!parsed.ok) return parsed.response;
  const { projectId } = await context.params;
  const title = parsed.body.get("title");
  const tags = parsed.body.get("tags");
  const image = parsed.body.get("image");
  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    title.trim().length > 120 ||
    (typeof tags !== "string" && tags !== null) ||
    (typeof tags === "string" && tags.length > 1_000) ||
    !(image instanceof File)
  ) {
    return Response.json(
      { error: "Add a title and a PNG, JPEG, WebP, or GIF reference." },
      { status: 400 },
    );
  }

  try {
    const project = await resolveProjectRequest(projectId);
    const reference: Reference = {
      id: randomUUID(),
      projectId: project.id,
      title: title.trim(),
      type: image.type.toLowerCase(),
      source: "upload",
      likes: [],
      dislikes: [],
      tags:
        typeof tags === "string"
          ? tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean)
              .slice(0, 20)
          : [],
      analysisStatus: "READY",
      createdAt: new Date().toISOString(),
    };
    await saveReferenceArtifact(
      project.rootPath,
      reference,
      new Uint8Array(await image.arrayBuffer()),
    );
    return Response.json({ reference: referenceView(reference) }, { status: 201 });
  } catch {
    return Response.json(
      { error: "Reference must be a non-empty PNG, JPEG, WebP, or GIF up to 10 MiB whose content matches its type." },
      { status: 422 },
    );
  }
}
