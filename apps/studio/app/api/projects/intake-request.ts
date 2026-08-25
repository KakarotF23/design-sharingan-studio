const MAX_INTAKE_BYTES = 16 * 1024;

export type IntakeRequestResult =
  | { ok: true; body: unknown }
  | { ok: false; response: Response };

function rejected(status: number, error: string): IntakeRequestResult {
  return {
    ok: false,
    response: Response.json({ error }, { status }),
  };
}

function hasJsonMediaType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  const requestOrigins = new Set([requestUrl.origin]);
  const requestHost = request.headers.get("host");
  if (requestHost !== null) {
    requestOrigins.add(`${requestUrl.protocol}//${requestHost}`);
  }
  try {
    if (origin !== null) {
      const parsedOrigin = new URL(origin);
      return (
        origin === parsedOrigin.origin && requestOrigins.has(parsedOrigin.origin)
      );
    }

    const referer = request.headers.get("referer");
    return referer !== null && requestOrigins.has(new URL(referer).origin);
  } catch {
    return false;
  }
}

async function readBoundedBody(request: Request): Promise<Uint8Array | undefined> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INTAKE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readIntakeJson(
  request: Request,
): Promise<IntakeRequestResult> {
  if (!hasJsonMediaType(request)) {
    return rejected(415, "Project intake requires JSON.");
  }
  if (!isSameOrigin(request)) {
    return rejected(403, "Project intake request was rejected.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return rejected(400, "Send a valid JSON request.");
    }
    if (Number(contentLength) > MAX_INTAKE_BYTES) {
      return rejected(413, "Project intake request is too large.");
    }
  }

  const bytes = await readBoundedBody(request);
  if (bytes === undefined) {
    return rejected(413, "Project intake request is too large.");
  }

  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, body: JSON.parse(json) as unknown };
  } catch {
    return rejected(400, "Send a valid JSON request.");
  }
}
