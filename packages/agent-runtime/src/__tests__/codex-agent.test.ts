import { describe, expect, it } from "vitest";
import {
  CodexAgent,
  type CodexProvider,
  type CodexProviderRunInput,
  type CodexProviderRunOptions,
  type CodexProviderThreadOptions,
} from "../codex-agent";

describe("CodexAgent", () => {
  // Production break caught: dropping project/image/schema context would make the shared runtime analyze the wrong evidence or return unvalidated prose.
  it("passes working directory, images, and output schema to Codex", async () => {
    let fakeThreadOptions: CodexProviderThreadOptions | undefined;
    let fakeRunInput: CodexProviderRunInput | undefined;
    let fakeRunOptions: CodexProviderRunOptions | undefined;

    const fakeProvider: CodexProvider = {
      startThread(options) {
        fakeThreadOptions = options;
        return {
          id: "thread-new",
          async run(input, options) {
            fakeRunInput = input;
            fakeRunOptions = options;
            return {
              finalResponse: '{"summary":"ok"}',
              items: [{ id: "message-1", type: "agent_message", text: "ok" }],
            };
          },
        };
      },
      resumeThread() {
        throw new Error("unexpected resume");
      },
    };
    const agent = new CodexAgent({ provider: fakeProvider });
    const outputSchema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    } as const;

    const result = await agent.run<{ summary: string }>({
      workingDirectory: "/project",
      prompt: "Analyze this reference",
      images: ["/project/.design-sharingan/references/ref.png"],
      outputSchema,
    });

    expect(fakeThreadOptions?.workingDirectory).toBe("/project");
    expect(fakeRunInput?.images).toEqual([
      "/project/.design-sharingan/references/ref.png",
    ]);
    expect(fakeRunInput?.prompt).toBe("Analyze this reference");
    expect(fakeRunOptions?.outputSchema).toBe(outputSchema);
    expect(result).toEqual({
      threadId: "thread-new",
      finalResponse: '{"summary":"ok"}',
      structured: { summary: "ok" },
      items: [{ id: "message-1", type: "agent_message", text: "ok" }],
    });
  });

  // Production break caught: starting a replacement conversation loses the approved direction and mutation history attached to a persisted session.
  it("resumes the stored thread in the active project working directory", async () => {
    let resumedThreadId: string | undefined;
    let resumedThreadOptions: CodexProviderThreadOptions | undefined;
    const fakeProvider: CodexProvider = {
      startThread() {
        throw new Error("unexpected new thread");
      },
      resumeThread(threadId, options) {
        resumedThreadId = threadId;
        resumedThreadOptions = options;
        return {
          id: threadId,
          async run() {
            return {
              finalResponse: "continued",
              items: [],
            };
          },
        };
      },
    };

    const result = await new CodexAgent({ provider: fakeProvider }).run({
      workingDirectory: "/project",
      prompt: "Continue the approved work",
      threadId: "thread-saved",
    });

    expect(resumedThreadId).toBe("thread-saved");
    expect(resumedThreadOptions?.workingDirectory).toBe("/project");
    expect(result.threadId).toBe("thread-saved");
  });

  // Production break caught: returning agent text or loggable event payloads verbatim can expose configured repository/API credentials in Studio activity and saved reports.
  it("redacts configured environment secrets from surfaced results", async () => {
    const secret = "top-secret-value";
    const fakeProvider: CodexProvider = {
      startThread() {
        return {
          id: "thread-redacted",
          async run() {
            return {
              finalResponse: JSON.stringify({ summary: `found ${secret}` }),
              items: [
                {
                  id: "command-1",
                  type: "command_execution",
                  command: `print ${secret}`,
                  aggregated_output: `token=${secret}`,
                  exit_code: 1,
                  status: "failed",
                },
              ],
            };
          },
        };
      },
      resumeThread() {
        throw new Error("unexpected resume");
      },
    };
    const agent = new CodexAgent({
      provider: fakeProvider,
      environment: { PRIVATE_TOKEN: secret },
      secretEnvironmentKeys: ["PRIVATE_TOKEN"],
    });

    const result = await agent.run<{ summary: string }>({
      workingDirectory: "/project",
      prompt: "Analyze safely",
      outputSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    });

    expect(result.finalResponse).toBe('{"summary":"found [REDACTED]"}');
    expect(result.structured).toEqual({ summary: "found [REDACTED]" });
    expect(JSON.stringify(result.items)).not.toContain(secret);
    expect(result.items[0]).toMatchObject({
      command: "print [REDACTED]",
      aggregated_output: "token=[REDACTED]",
    });
  });

  // Production break caught: an SDK/CLI failure containing inherited credentials can otherwise escape the runtime boundary through its thrown message.
  it("redacts configured environment secrets from surfaced errors", async () => {
    const secret = "top-secret-value";
    const fakeProvider: CodexProvider = {
      startThread() {
        return {
          id: "thread-error",
          async run() {
            throw new Error(`Codex failed with ${secret}`);
          },
        };
      },
      resumeThread() {
        throw new Error("unexpected resume");
      },
    };
    const agent = new CodexAgent({
      provider: fakeProvider,
      environment: { PRIVATE_TOKEN: secret },
      secretEnvironmentKeys: ["PRIVATE_TOKEN"],
    });

    const error = await agent
      .run({ workingDirectory: "/project", prompt: "Analyze safely" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Codex failed with [REDACTED]");
    expect((error as Error).message).not.toContain(secret);
  });
});

const integrationIt =
  process.env.RUN_CODEX_INTEGRATION === "1" ? it : it.skip;

integrationIt(
  "returns a live two-field response that adheres to the requested schema",
  async () => {
    const result = await new CodexAgent({
      secretEnvironmentKeys: [
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "GITHUB_TOKEN",
      ],
    }).run<{ summary: string; status: "ok" }>({
      workingDirectory: process.cwd(),
      prompt:
        'Return a JSON object with summary exactly "runtime connected" and status exactly "ok". Do not inspect or modify files.',
      outputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          status: { type: "string", enum: ["ok"] },
        },
        required: ["summary", "status"],
        additionalProperties: false,
      },
    });

    expect(result.structured).toEqual({
      summary: "runtime connected",
      status: "ok",
    });
    expect(result.threadId.length).toBeGreaterThan(0);
  },
  120_000,
);
