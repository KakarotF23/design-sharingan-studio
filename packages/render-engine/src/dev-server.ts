import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ProjectWorkspace } from "@design-sharingan/project-adapters";
import { assertLoopbackBaseUrl, probeReadiness, waitForReadiness } from "./readiness";

const MAX_OUTPUT_BYTES = 65_536;

export interface ProcessCommand {
  executable: "pnpm" | "npm" | "yarn";
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export interface DevProcess {
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

export interface ProcessRunner {
  start(command: ProcessCommand): DevProcess;
}

export interface DevServerHandle {
  baseUrl: string;
  readonly output: string;
  stop(): Promise<void>;
}

export interface StartDevServerOptions {
  workspace: ProjectWorkspace;
  baseUrl: string;
  processRunner?: ProcessRunner;
  readinessProbe?: (url: string, signal: AbortSignal) => Promise<boolean>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string>>;
}

function commandFor(workspace: ProjectWorkspace): Pick<ProcessCommand, "executable" | "args"> {
  const supported: Record<string, Pick<ProcessCommand, "executable" | "args">> = {
    "pnpm dev": { executable: "pnpm", args: ["run", "dev"] },
    "yarn dev": { executable: "yarn", args: ["run", "dev"] },
    "npm run dev": { executable: "npm", args: ["run", "dev"] },
    "npm start": { executable: "npm", args: ["run", "start"] },
  };
  const command = workspace.devCommand === undefined ? undefined : supported[workspace.devCommand];
  if (command === undefined) {
    throw new Error("Project does not have a supported detected dev command");
  }
  return command;
}

function redact(value: string, extraSecrets: readonly string[]): string {
  let result = value;
  const secrets = [...Object.values(process.env), ...extraSecrets]
    .filter((entry): entry is string => typeof entry === "string" && entry.length >= 8)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
  return result.replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})/g, "[REDACTED]");
}

function truncateUtf8(value: string, byteLimit: number): string {
  let retained = "";
  let bytes = 0;
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > byteLimit) break;
    retained += codePoint;
    bytes += size;
  }
  return retained;
}

class StreamingRedactor {
  readonly #decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  readonly #secrets: string[];
  #raw = "";
  #flushed = false;

  constructor(extraSecrets: readonly string[]) {
    this.#secrets = [...Object.values(process.env), ...extraSecrets]
      .filter((entry): entry is string =>
        typeof entry === "string" && entry.length >= 8 && Buffer.byteLength(entry, "utf8") <= 4_096)
      .sort((left, right) => right.length - left.length);
  }

  append(source: "stdout" | "stderr", chunk: Buffer | string): void {
    if (this.#flushed || Buffer.byteLength(this.output, "utf8") >= MAX_OUTPUT_BYTES) return;
    this.#raw += typeof chunk === "string" ? chunk : this.#decoders[source].write(chunk);
    const retentionBytes = MAX_OUTPUT_BYTES + Math.max(512, ...this.#secrets.map((secret) => Buffer.byteLength(secret))) + 256;
    this.#raw = truncateUtf8(this.#raw, retentionBytes);
  }

  flush(): void {
    if (this.#flushed) return;
    this.#raw += this.#decoders.stdout.end();
    this.#raw += this.#decoders.stderr.end();
    this.#flushed = true;
  }

  #pendingLength(): number {
    let longest = 0;
    for (const secret of this.#secrets) {
      const upperBound = Math.min(secret.length - 1, this.#raw.length);
      for (let length = upperBound; length > longest; length -= 1) {
        if (this.#raw.endsWith(secret.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
    const github = this.#raw.match(/(?:g|gh|gh[pousr]|gh[pousr]_([A-Za-z0-9_]*))$/);
    if (github !== null && (github[1] === undefined || github[1].length < 20)) {
      longest = Math.max(longest, github[0].length);
    }
    const openAi = this.#raw.match(/(?:s|sk|sk-([A-Za-z0-9_-]*))$/);
    if (openAi !== null && (openAi[1] === undefined || openAi[1].length < 16)) {
      longest = Math.max(longest, openAi[0].length);
    }
    return longest;
  }

  get output(): string {
    const pending = this.#pendingLength();
    const safeRaw = pending === 0
      ? this.#raw
      : `${this.#raw.slice(0, -pending)}${this.#flushed ? "[REDACTED]" : ""}`;
    return truncateUtf8(redact(safeRaw, this.#secrets), MAX_OUTPUT_BYTES);
  }
}

function projectEnvironment(
  explicit: Readonly<Record<string, string>> | undefined,
  isolatedHome: string,
): NodeJS.ProcessEnv {
  const inheritedKeys = ["PATH", "TMPDIR", "TMP", "TEMP", "NODE_ENV", "CI", "NO_COLOR"] as const;
  const environment: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, "config"),
    XDG_CACHE_HOME: join(isolatedHome, "cache"),
    NPM_CONFIG_USERCONFIG: join(isolatedHome, "npm-user-config"),
    NPM_CONFIG_GLOBALCONFIG: join(isolatedHome, "npm-global-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(isolatedHome, "git-global-config"),
    GIT_CONFIG_SYSTEM: join(isolatedHome, "git-system-config"),
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(explicit ?? {})) {
    if (Buffer.byteLength(value, "utf8") > 4_096) {
      throw new Error(`Dev server environment value is too large: ${key}`);
    }
    if (
      !/^[A-Z_][A-Z0-9_]*$/.test(key) ||
      /^(?:PATH|HOME|NODE_OPTIONS|BASH_ENV|ENV|SHELLOPTS|PNPM_HOME|INIT_CWD)$/i.test(key) ||
      /^(?:NPM_CONFIG|YARN_|GIT_)/i.test(key) ||
      value.includes("\0")
    ) {
      throw new Error(`Dev server environment key is not allowed: ${key}`);
    }
    environment[key] = value;
  }
  return environment;
}

export const defaultProcessRunner: ProcessRunner = {
  start(command): DevProcess {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", () => reject(new Error("Dev server process could not be started")));
      child.once("close", resolve);
    });
    const ownedProcessGroup = process.platform !== "win32" ? child.pid : undefined;
    let stopped = false;
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      async stop() {
        if (stopped) return;
        stopped = true;
        const groupAlive = (): boolean => {
          if (ownedProcessGroup === undefined) return child.exitCode === null;
          try {
            process.kill(-ownedProcessGroup, 0);
            return true;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "EPERM";
          }
        };
        const signalOwnedTree = (signal: NodeJS.Signals) => {
          if (ownedProcessGroup !== undefined) {
            try {
              process.kill(-ownedProcessGroup, signal);
              return;
            } catch {
              // The owned group may already be gone; only signal a still-running leader.
            }
          }
          if (child.exitCode === null) child.kill(signal);
        };
        const waitForOwnedTree = async (milliseconds: number): Promise<boolean> => {
          const deadline = Date.now() + milliseconds;
          while (groupAlive() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return !groupAlive();
        };
        signalOwnedTree("SIGTERM");
        const graceful = await waitForOwnedTree(2_000);
        if (!graceful) {
          signalOwnedTree("SIGKILL");
          if (!await waitForOwnedTree(2_000)) {
            throw new Error("Owned dev server process group did not terminate");
          }
        }
        await Promise.race([
          exited.catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
        ]);
      },
    };
  },
};

async function waitWithProbe(options: StartDevServerOptions, signal: AbortSignal): Promise<void> {
  if (options.readinessProbe === undefined) {
    await waitForReadiness({
      url: options.baseUrl,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      signal,
    });
    return;
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("Readiness wait was aborted");
    if (await options.readinessProbe(options.baseUrl, signal)) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }
  throw new Error(`Dev server was not ready within ${timeoutMs} ms`);
}

export async function startDevServer(options: StartDevServerOptions): Promise<DevServerHandle> {
  assertLoopbackBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new Error("Readiness timeout is outside the supported range");
  }
  if (
    options.workspace.status !== "READY" ||
    !options.workspace.capabilities.canRun ||
    !options.workspace.capabilities.canRender
  ) {
    throw new Error("Workspace is not ready or authorized to run and render");
  }
  const canonicalRoot = await realpath(options.workspace.rootPath);
  if (canonicalRoot !== options.workspace.rootPath) {
    throw new Error("Active project root must be canonical");
  }
  const parsed = commandFor(options.workspace);
  const preflightAbort = new AbortController();
  let preflightTimer: ReturnType<typeof setTimeout> | undefined;
  const preflightDeadline = new Promise<never>((_resolve, reject) => {
    preflightTimer = setTimeout(
      () => reject(new Error("Could not confirm that the render base URL is unused")),
      Math.min(timeoutMs, 500),
    );
  });
  try {
    const alreadyReady = await Promise.race([
      options.readinessProbe === undefined
        ? probeReadiness(options.baseUrl, fetch, Math.min(timeoutMs, 500))
        : options.readinessProbe(options.baseUrl, preflightAbort.signal),
      preflightDeadline,
    ]);
    if (alreadyReady) {
      throw new Error("Render base URL is already responding; refusing to start an unrelated child");
    }
  } finally {
    preflightAbort.abort();
    if (preflightTimer !== undefined) clearTimeout(preflightTimer);
  }
  const isolatedHome = await mkdtemp(join(tmpdir(), "design-sharingan-render-home-"));
  const environment = projectEnvironment(options.env, isolatedHome);
  const explicitSecrets = Object.values(options.env ?? {}).filter((value) => value.length >= 8);
  let child: DevProcess;
  try {
    child = (options.processRunner ?? defaultProcessRunner).start({
      ...parsed,
      cwd: canonicalRoot,
      shell: false,
      env: environment,
    });
  } catch (error) {
    await rm(isolatedHome, { recursive: true, force: true });
    throw error;
  }
  const output = new StreamingRedactor(explicitSecrets);
  child.stdout?.on("data", (chunk) => { output.append("stdout", chunk); });
  child.stderr?.on("data", (chunk) => { output.append("stderr", chunk); });
  void child.exited.finally(() => output.flush()).catch(() => undefined);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await child.stop();
    } finally {
      output.flush();
      await rm(isolatedHome, { recursive: true, force: true });
    }
  };
  const readinessAbort = new AbortController();
  let rejectExternalAbort: ((error: Error) => void) | undefined;
  const externalAbort = new Promise<never>((_resolve, reject) => {
    rejectExternalAbort = reject;
  });
  const abortListener = () => {
    readinessAbort.abort();
    rejectExternalAbort?.(new Error("Dev server start was aborted"));
  };
  options.signal?.addEventListener("abort", abortListener, { once: true });
  if (options.signal?.aborted) abortListener();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Dev server was not ready within ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([
      waitWithProbe(options, readinessAbort.signal),
      child.exited.then((code) => {
        throw new Error(`Dev server exited before readiness with code ${String(code)}`);
      }),
      externalAbort,
      deadline,
    ]);
  } catch (error) {
    readinessAbort.abort();
    await stop();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortListener);
  }
  return {
    baseUrl: options.baseUrl,
    get output() { return output.output; },
    stop,
  };
}
