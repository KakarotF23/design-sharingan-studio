import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CodexOptions } from "@openai/codex-sdk";

// The pinned CLI emits this exact startup diagnostic even on a successful,
// tool-free turn when we intentionally disable its code-mode host. It is not
// a tool result. All other error items and all execution/tool items still fail.
export function isDisabledCapabilityNotice(item: { type: string; message?: unknown }): boolean {
  return item.type === "error" && item.message === "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";
}

function privateWrite(path: string, contents: string | Buffer) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, contents); } finally { closeSync(fd); }
}

export function restrictedCodexRuntime(environment: Readonly<Record<string, string | undefined>>) {
  const ambientHome = resolve(environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), ".codex"));
  const runtime = join(realpathSync(tmpdir()), `design-sharingan-agent-${process.getuid?.() ?? "local"}-${createHash("sha256").update(ambientHome).digest("hex").slice(0, 24)}`);
  const ensurePrivate = (path: string) => {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 ||
        entry.uid !== process.getuid?.() || realpathSync(path) !== path) throw new Error("Agent runtime is not a private owned directory");
  };
  ensurePrivate(runtime);
  const isolatedHome = join(runtime, "home");
  const codexHome = join(runtime, "codex");
  const owners = join(runtime, "owned-threads");
  for (const path of [isolatedHome, codexHome, owners]) ensurePrivate(path);
  // Copy authentication only, never ambient config, hooks, plugins, skills or sessions.
  const authPath = join(ambientHome, "auth.json");
  if (existsSync(authPath)) {
    const fd = openSync(authPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = fstatSync(fd);
      if (!entry.isFile() || entry.size > 256_000) throw new Error("Codex authentication file is invalid");
      privateWrite(join(codexHome, "auth.json"), readFileSync(fd));
    } finally { closeSync(fd); }
  }
  const env: Record<string, string> = { HOME: isolatedHome, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" };
  for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  const options: CodexOptions = {
    env,
    config: {
      shell_environment_policy: { inherit: "none" },
      sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_slash_tmp: true, exclude_tmpdir_env_var: true },
      features: { shell_tool: false, unified_exec: false, shell_snapshot: false, plugins: false, apps: false, hooks: false, multi_agent: false, multi_agent_v2: false, browser_use: false, computer_use: false, image_generation: false, code_mode: false, code_mode_host: false, workspace_dependencies: false, skill_search: false },
      apps: { _default: { enabled: false } },
      project_doc_max_bytes: 0,
    },
    configOverrides: ["mcp_servers={}", "plugins={}"],
  };
  const ownerPath = (id: string) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Agent thread identity is invalid");
    return join(owners, id);
  };
  return {
    options,
    requireOwnedThread(id: string) {
      const path = ownerPath(id);
      if (!existsSync(path) || lstatSync(path).isSymbolicLink() || readFileSync(path, "utf8") !== "studio-agent-v1") throw new Error("Only a Studio-owned agent thread may be resumed");
    },
    rememberThread(id: string) {
      privateWrite(ownerPath(id), "studio-agent-v1");
    },
  };
}
