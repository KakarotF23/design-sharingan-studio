import { loadReferenceImage } from "@design-sharingan/project-adapters";
import { resolveProjectRequest } from "../../../../../../features/projects/project-access";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ projectId: string; referenceId: string }>;
  },
): Promise<Response> {
  const { projectId, referenceId } = await context.params;
  try {
    const project = await resolveProjectRequest(projectId);
    const image = await loadReferenceImage(
      project.rootPath,
      project.id,
      referenceId,
    );
    const body = new ArrayBuffer(image.bytes.byteLength);
    new Uint8Array(body).set(image.bytes);
    return new Response(body, {
      headers: {
        "cache-control": "private, no-store",
        "content-length": String(image.bytes.byteLength),
        "content-type": image.type,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
