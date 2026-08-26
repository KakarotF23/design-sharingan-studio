const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export interface ReadinessOptions {
  url: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export function assertLoopbackBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Render base URL must be a valid loopback URL");
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Render base URL must use HTTP on a loopback address");
  }
  return url;
}

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error(`${label} is outside the supported range`);
  }
  return resolved;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Readiness wait was aborted"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Readiness wait was aborted"));
    }, { once: true });
  });
}

async function probeOnce(
  url: URL,
  fetchImpl: typeof fetch,
  remainingMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  try {
    let current = url;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      try {
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null) return false;
          const redirected = new URL(location, current);
          if (redirected.origin !== url.origin) {
            throw new Error("Readiness redirect left the configured origin");
          }
          current = redirected;
          continue;
        }
        return response.status >= 200 && response.status < 500;
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    }
    throw new Error("Readiness exceeded the redirect limit");
  } catch (error) {
    if (
      error instanceof Error &&
      (/redirect/i.test(error.message) || /loopback/i.test(error.message))
    ) {
      throw error;
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeReadiness(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 500,
): Promise<boolean> {
  const target = assertLoopbackBaseUrl(url);
  return probeOnce(target, fetchImpl, timeoutMs);
}

export async function waitForReadiness(options: ReadinessOptions): Promise<void> {
  const url = assertLoopbackBaseUrl(options.url);
  const timeoutMs = positiveBoundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 300_000, "Readiness timeout");
  const pollIntervalMs = positiveBoundedInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 10_000, "Readiness poll interval");
  const deadline = Date.now() + timeoutMs;
  const fetchImpl = options.fetchImpl ?? fetch;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error("Readiness wait was aborted");
    if (await probeOnce(url, fetchImpl, Math.max(1, deadline - Date.now()))) return;
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(pollIntervalMs, remaining), options.signal);
  }
  throw new Error(`Dev server was not ready within ${timeoutMs} ms`);
}
