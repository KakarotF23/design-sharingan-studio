import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";
import {
  createDenyByDefaultCodexAgent,
  type DenyByDefaultCodexClient,
  type DenyByDefaultCodexClientOptions,
} from "../deny-by-default-codex";

function clientReturning(events: readonly ThreadEvent[]) {
  const calls: ThreadOptions[] = [];
  const client: DenyByDefaultCodexClient = {
    startThread(options) {
      if (options === undefined) throw new Error("Expected explicit thread options");
      calls.push(options);
      return {
        get id() {
          return "eternal-thread";
        },
        async runStreamed() {
          return {
            events: (async function* () {
              yield* events;
            })(),
          };
        },
      };
    },
    resumeThread() {
      throw new Error("Eternal initialization must not resume an ambient thread");
    },
  };
  return { calls, client };
}

describe("deny-by-default Eternal Codex provider", () => {
  // Production break caught: relaxing any SDK option would let live Genome analysis inherit write, approval, directory, Git, web, or network authority.
  it("constructs the live thread with the exact supported read-only boundary", async () => {
    const fake = clientReturning([
      { type: "thread.started", thread_id: "eternal-thread" },
      {
        type: "item.completed",
        item: { id: "message-1", type: "agent_message", text: '{"ok":true}' },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      },
    ]);
    const agent = createDenyByDefaultCodexAgent({ client: fake.client });

    const result = await agent.run<{ ok: boolean }>({
      workingDirectory: "/authenticated/non-git-project",
      prompt: "Inspect supplied evidence only.",
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    });

    expect(fake.calls).toEqual([{
      workingDirectory: "/authenticated/non-git-project",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      additionalDirectories: [],
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    }]);
    expect(result.structured).toEqual({ ok: true });
  });

  // Production break caught: inheriting the host environment would expose unrelated repository, cloud, and connector credentials to the live analysis subprocess.
  it("constructs the official client with an explicit minimal environment", async () => {
    const fake = clientReturning([]);
    let clientOptions: DenyByDefaultCodexClientOptions | undefined;

    createDenyByDefaultCodexAgent({
      environment: {
        HOME: "/Users/local",
        CODEX_HOME: "/Users/local/.codex",
        PATH: "/usr/bin",
        TMPDIR: "/tmp",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        CODEX_API_KEY: "codex-key",
        OPENAI_API_KEY: "openai-key",
        SSL_CERT_FILE: "/etc/cert.pem",
        SSL_CERT_DIR: "/etc/certs",
        GITHUB_TOKEN: "must-not-leak",
        AWS_SECRET_ACCESS_KEY: "must-not-leak",
      },
      createClient(options) {
        clientOptions = options;
        return fake.client;
      },
    });

    expect(clientOptions).toEqual({
      env: {
        HOME: "/Users/local",
        CODEX_HOME: "/Users/local/.codex",
        PATH: "/usr/bin",
        TMPDIR: "/tmp",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        CODEX_API_KEY: "codex-key",
        OPENAI_API_KEY: "openai-key",
        SSL_CERT_FILE: "/etc/cert.pem",
        SSL_CERT_DIR: "/etc/certs",
      },
    });
  });

  // Production break caught: merely using a read-only sandbox still permits commands and tools to inspect data beyond the bounded evidence prompt.
  it.each([
    {
      id: "command",
      item: {
        id: "command-1",
        type: "command_execution",
        command: "pwd",
        aggregated_output: "",
        status: "in_progress",
      },
    },
    {
      id: "file change",
      item: {
        id: "file-1",
        type: "file_change",
        changes: [{ path: "README.md", kind: "update" }],
        status: "completed",
      },
    },
    {
      id: "MCP tool",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        server: "filesystem",
        tool: "read_file",
        arguments: {},
        status: "in_progress",
      },
    },
    {
      id: "web search",
      item: { id: "web-1", type: "web_search", query: "private product" },
    },
  ] as const)("fails closed on a $id event", async ({ item }) => {
    const fake = clientReturning([
      { type: "thread.started", thread_id: "eternal-thread" },
      { type: "item.started", item } as ThreadEvent,
    ]);
    const agent = createDenyByDefaultCodexAgent({ client: fake.client });

    await expect(agent.run({
      workingDirectory: "/authenticated/project",
      prompt: "Inspect supplied evidence only.",
    })).rejects.toThrow(/forbidden.*event/i);
  });

  // Production break caught: allowing callers to resume a persisted thread can reintroduce tools or instructions from an unrelated workflow.
  it("rejects ambient thread resumption", async () => {
    const fake = clientReturning([]);
    const agent = createDenyByDefaultCodexAgent({ client: fake.client });

    await expect(agent.run({
      workingDirectory: "/authenticated/project",
      prompt: "Inspect supplied evidence only.",
      threadId: "ambient-thread",
    })).rejects.toThrow(/must not resume/i);
  });

  // Production break caught: SDK local-image inputs are host filesystem reads, not bounded representative evidence.
  it("rejects local image attachments", async () => {
    const fake = clientReturning([]);
    const agent = createDenyByDefaultCodexAgent({ client: fake.client });

    await expect(agent.run({
      workingDirectory: "/authenticated/project",
      prompt: "Inspect supplied evidence only.",
      images: ["/outside/authenticated/evidence.png"],
    })).rejects.toThrow(/image attachments.*forbidden/i);
  });

  it("fails closed on a surfaced SDK error item", async () => {
    const fake = clientReturning([
      { type: "thread.started", thread_id: "eternal-thread" },
      {
        type: "item.completed",
        item: { id: "error-1", type: "error", message: "provider boundary failed" },
      },
    ]);
    const agent = createDenyByDefaultCodexAgent({ client: fake.client });

    await expect(agent.run({
      workingDirectory: "/authenticated/project",
      prompt: "Inspect supplied evidence only.",
    })).rejects.toThrow(/provider boundary failed/i);
  });
});
