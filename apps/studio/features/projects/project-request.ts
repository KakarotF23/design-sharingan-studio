import {
  isSameOriginRequest,
  readBoundedRequestBody,
} from "../../app/api/projects/intake-request";

export type ProjectRequestResult<T> =
  | { ok: true; body: T }
  | { ok: false; response: Response };

const MAX_PROJECT_JSON_BYTES = 32 * 1024;
const MAX_PROJECT_MULTIPART_BYTES = 10 * 1024 * 1024 + 64 * 1024;

function rejected(status: number, error: string): ProjectRequestResult<never> {
  return { ok: false, response: Response.json({ error }, { status }) };
}

function mediaType(request: Request): string | undefined {
  return request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
}

function declaredLengthIsAllowed(
  request: Request,
  maxBytes: number,
): boolean | undefined {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null) return true;
  if (!/^\d+$/.test(contentLength)) return undefined;
  return Number(contentLength) <= maxBytes;
}

export async function readProjectJson(
  request: Request,
): Promise<ProjectRequestResult<unknown>> {
  if (mediaType(request) !== "application/json") {
    return rejected(415, "Project request requires JSON.");
  }
  if (!isSameOriginRequest(request)) {
    return rejected(403, "Project request was rejected.");
  }
  const declaredLength = declaredLengthIsAllowed(
    request,
    MAX_PROJECT_JSON_BYTES,
  );
  if (declaredLength === undefined) {
    return rejected(400, "Send a valid JSON request.");
  }
  if (!declaredLength) {
    return rejected(413, "Project request is too large.");
  }
  const bytes = await readBoundedRequestBody(request, MAX_PROJECT_JSON_BYTES);
  if (bytes === undefined) {
    return rejected(413, "Project request is too large.");
  }
  try {
    return {
      ok: true,
      body: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown,
    };
  } catch {
    return rejected(400, "Send a valid JSON request.");
  }
}

export async function readProjectMultipart(
  request: Request,
): Promise<ProjectRequestResult<FormData>> {
  const contentType = request.headers.get("content-type");
  if (
    mediaType(request) !== "multipart/form-data" ||
    contentType === null ||
    !/;\s*boundary=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+")\s*$/i.test(
      contentType,
    )
  ) {
    return rejected(415, "Reference upload requires multipart form data.");
  }
  if (!isSameOriginRequest(request)) {
    return rejected(403, "Project request was rejected.");
  }
  const declaredLength = declaredLengthIsAllowed(
    request,
    MAX_PROJECT_MULTIPART_BYTES,
  );
  if (declaredLength === undefined) {
    return rejected(400, "Send a valid reference upload.");
  }
  if (!declaredLength) {
    return rejected(413, "Reference upload is too large.");
  }
  const bytes = await readBoundedRequestBody(
    request,
    MAX_PROJECT_MULTIPART_BYTES,
  );
  if (bytes === undefined) {
    return rejected(413, "Reference upload is too large.");
  }
  try {
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const parsed = new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
    return { ok: true, body: await parsed.formData() };
  } catch {
    return rejected(400, "Send a valid reference upload.");
  }
}
