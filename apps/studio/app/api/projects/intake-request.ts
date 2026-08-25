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

function localListenerOrigin(request: Request): string | undefined {
  if (request.headers.get("forwarded") !== null) return undefined;

  const protocol = new URL(request.url).protocol;
  if (protocol !== "http:" && protocol !== "https:") return undefined;

  const authority = request.headers.get("host");
  if (
    authority === null ||
    authority.length === 0 ||
    authority.length > 255 ||
    /[\s\0\r\n,@/?#\\]/.test(authority)
  ) {
    return undefined;
  }

  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/i.exec(
    authority,
  );
  if (match === null) return undefined;

  const port = match[2];
  if (port !== undefined && Number(port) > 65_535) return undefined;

  const hostname = (match[1] as string).toLowerCase();
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedPort = request.headers.get("x-forwarded-port");
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  if (
    (forwardedHost !== null &&
      forwardedHost.toLowerCase() !== authority.toLowerCase()) ||
    (forwardedPort !== null &&
      forwardedPort !== (port ?? (protocol === "https:" ? "443" : "80"))) ||
    (forwardedProtocol !== null &&
      forwardedProtocol.toLowerCase() !== protocol.slice(0, -1))
  ) {
    return undefined;
  }
  return `${protocol}//${hostname}${port === undefined ? "" : `:${port}`}`;
}

function isSameOrigin(request: Request): boolean {
  const listenerOrigin = localListenerOrigin(request);
  if (listenerOrigin === undefined) return false;

  const origin = request.headers.get("origin");
  try {
    if (origin !== null) {
      const parsedOrigin = new URL(origin);
      return (
        parsedOrigin.username === "" &&
        parsedOrigin.password === "" &&
        origin === parsedOrigin.origin && parsedOrigin.origin === listenerOrigin
      );
    }

    const referer = request.headers.get("referer");
    if (referer === null) return false;
    const parsedReferer = new URL(referer);
    return (
      parsedReferer.username === "" &&
      parsedReferer.password === "" &&
      parsedReferer.origin === listenerOrigin
    );
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
