import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import { expect, it } from "vitest";
import { CodexAgent } from "../codex-agent";

// Production break caught: ambient dangerous configuration, connector hooks, and host credentials reach a Studio-spawned analysis process.
it("isolates ambient configuration and denies execution capabilities before the SDK turn", async () => {
  const ambient = await mkdtemp(join(tmpdir(), "agent-ambient-"));
  try {
    await writeFile(join(ambient, "config.toml"), 'sandbox_mode="danger-full-access"\n[mcp_servers.evil]\ncommand="touch"\n');
    let clientOptions: CodexOptions | undefined;
    let threadOptions: ThreadOptions | undefined;
    const agent = new CodexAgent({
      environment: { CODEX_HOME: ambient, HOME: ambient, PATH: "/usr/bin:/bin", GITHUB_TOKEN: "ambient-secret" },
      createClient(options: CodexOptions) {
        clientOptions = options;
        return {
          startThread(options: ThreadOptions) {
            threadOptions = options;
            return { id: "safe-thread", async run() { return { finalResponse: "ok ambient-secret", items: [] }; } };
          },
          resumeThread() { throw new Error("Unexpected resume"); },
        };
      },
    });
    expect(clientOptions, "the official SDK must be constructed with a restricted environment").toBeDefined();
    const result = await agent.run({ workingDirectory: ambient, prompt: "Analyze supplied evidence" });
    expect(threadOptions).toMatchObject({ sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false, webSearchMode: "disabled", additionalDirectories: [] });
    expect(clientOptions?.env?.CODEX_HOME).not.toBe(ambient);
    expect(clientOptions?.env?.GITHUB_TOKEN).toBeUndefined();
    expect(clientOptions?.config).toMatchObject({ features: { shell_tool: false, plugins: false, apps: false, hooks: false, multi_agent: false }, shell_environment_policy: { inherit: "none" } });
    expect(await readdir(clientOptions!.env!.CODEX_HOME!)).not.toContain("config.toml");
    expect(result.finalResponse).not.toContain("ambient-secret");
    expect(await readFile(join(ambient, "config.toml"), "utf8")).toContain("danger-full-access");
  } finally { await rm(ambient, { recursive: true, force: true }); }
});

// Production break caught: resuming an arbitrary personal thread imports unreviewed instructions and capabilities into a mutation session.
it("refuses an unowned live SDK thread before resuming it", async () => {
  let created = false;
  const agent = new CodexAgent({ createClient() {
    created = true;
    return { startThread() { throw new Error("Unexpected start"); }, resumeThread() { throw new Error("Unsafe ambient resume"); } };
  } });
  expect(created).toBe(true);
  await expect(agent.run({ workingDirectory: "/tmp", prompt: "Continue", threadId: "ambient-thread" })).rejects.toThrow(/owned.*thread|thread.*owned/i);
});

// Production break caught: the pinned CLI emits its intentional disabled-code-mode startup notice as an error item, making even tool-free successful analysis unusable.
it("retains fail-closed tools while distinguishing the exact disabled-host startup notice from real runtime errors", async () => {
  let message = "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";
  const agent = new CodexAgent({ createClient() { return { startThread() { return { id: "notice-test-thread", async run() { return { finalResponse: "analysis complete", items: [{ type: "error" as const, id: "notice", message }] }; } }; }, resumeThread() { throw new Error("Unexpected resume"); } }; } });
  await expect(agent.run({ workingDirectory: "/tmp", prompt: "Analyze supplied text" })).resolves.toMatchObject({ finalResponse: "analysis complete" });
  message = "A connector failed after attempting external access";
  await expect(agent.run({ workingDirectory: "/tmp", prompt: "Analyze supplied text" })).rejects.toThrow(/connector failed/);
});
