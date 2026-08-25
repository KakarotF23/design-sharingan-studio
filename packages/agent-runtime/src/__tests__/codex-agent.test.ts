import { describe, expect, it } from "vitest";
import {
  CodexAgent,
  type CodexProvider,
  type CodexProviderRunInput,
  type CodexProviderRunOptions,
  type CodexProviderRunResult,
  type CodexProviderThreadOptions,
} from "../codex-agent";

const SAFE_SEPARATOR = "\u2063";
const REDACTED_MARKER = `${SAFE_SEPARATOR}[REDACTED]${SAFE_SEPARATOR}`;
const FILTERED_MARKER = `${SAFE_SEPARATOR}[FILTERED]${SAFE_SEPARATOR}`;

function providerReturning(
  finalResponse: string,
  items: CodexProviderRunResult["items"] = [],
): CodexProvider {
  return {
    startThread() {
      return {
        id: "thread-redaction-regression",
        async run() {
          return { finalResponse, items };
        },
      };
    },
    resumeThread() {
      throw new Error("unexpected resume");
    },
  };
}

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

    expect(result.finalResponse).toBe(
      JSON.stringify({ summary: `found ${REDACTED_MARKER}` }),
    );
    expect(result.structured).toEqual({
      summary: `found ${REDACTED_MARKER}`,
    });
    expect(JSON.stringify(result.items)).not.toContain(secret);
    expect(result.items[0]).toMatchObject({
      command: `print ${REDACTED_MARKER}`,
      aggregated_output: `token=${REDACTED_MARKER}`,
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
    expect((error as Error).message).toBe(
      `Codex failed with ${REDACTED_MARKER}`,
    );
    expect((error as Error).message).not.toContain(secret);
  });

  // Production break caught: redacting JSON text before parsing misses secrets whose quotes, slashes, newlines, or control bytes are escaped by serialization.
  it("sanitizes escaped secret values after parsing structured output", async () => {
    const secrets = {
      QUOTED_TOKEN: 'quote"secret',
      BACKSLASH_TOKEN: String.raw`back\slash-secret`,
      NEWLINE_TOKEN: "line\nsecret",
      CONTROL_TOKEN: `control${String.fromCharCode(1)}secret`,
    };
    const outputSchema = {
      type: "object",
      properties: {
        quoted: { type: "string" },
        backslash: { type: "string" },
        newline: { type: "string" },
        control: { type: "string" },
      },
      required: ["quoted", "backslash", "newline", "control"],
      additionalProperties: false,
    } as const;
    const agent = new CodexAgent({
      provider: providerReturning(
        JSON.stringify({
          quoted: secrets.QUOTED_TOKEN,
          backslash: secrets.BACKSLASH_TOKEN,
          newline: secrets.NEWLINE_TOKEN,
          control: secrets.CONTROL_TOKEN,
        }),
      ),
      environment: secrets,
      secretEnvironmentKeys: Object.keys(secrets),
    });

    const result = await agent.run<Record<string, string>>({
      workingDirectory: "/project",
      prompt: "Analyze safely",
      outputSchema,
    });

    expect(result.structured).toEqual({
      quoted: REDACTED_MARKER,
      backslash: REDACTED_MARKER,
      newline: REDACTED_MARKER,
      control: REDACTED_MARKER,
    });
    expect(result.finalResponse).toBe(JSON.stringify(result.structured));
  });

  // Production break caught: SDK errors can embed a JSON-encoded credential whose escaped representation contains no raw secret substring.
  it("redacts JSON-string-encoded secrets from surfaced errors", async () => {
    const secret = `quote"slash\\line\ncontrol${String.fromCharCode(2)}`;
    const provider: CodexProvider = {
      startThread() {
        return {
          id: "thread-serialized-error",
          async run() {
            throw new Error(`Codex failed with ${JSON.stringify(secret)}`);
          },
        };
      },
      resumeThread() {
        throw new Error("unexpected resume");
      },
    };
    const agent = new CodexAgent({
      provider,
      environment: { PRIVATE_TOKEN: secret },
      secretEnvironmentKeys: ["PRIVATE_TOKEN"],
    });

    const error = await agent
      .run({ workingDirectory: "/project", prompt: "Analyze safely" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `Codex failed with ${REDACTED_MARKER}`,
    );
    expect((error as Error).message).not.toContain(JSON.stringify(secret));
  });

  // Production break caught: V8 composes `name: message` when materializing a stack, which can recreate a configured secret even when both fields are independently safe.
  it("does not re-form configured secrets in surfaced error stacks", async () => {
    const secret = "CodexError: failed";
    const providerError = new Error("failed", { cause: secret });
    providerError.name = "CodexError";
    const provider: CodexProvider = {
      startThread() {
        return {
          id: "thread-composed-error",
          async run() {
            throw providerError;
          },
        };
      },
      resumeThread() {
        throw new Error("unexpected resume");
      },
    };
    const agent = new CodexAgent({
      provider,
      environment: { PRIVATE_TOKEN: secret },
      secretEnvironmentKeys: ["PRIVATE_TOKEN"],
    });

    const caught = await agent
      .run({ workingDirectory: "/project", prompt: "Analyze safely" })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    const surfaced = caught as Error;
    expect(surfaced.name).not.toContain(secret);
    expect(surfaced.message).not.toContain(secret);
    expect(surfaced.stack).not.toContain(secret);
    expect(surfaced.cause).toBeUndefined();
    expect(String(surfaced.cause)).not.toContain(secret);
  });

  // Production break caught: secrets in event property names are just as surfacing/loggable as secrets in their nested values.
  it("sanitizes nested event keys and values", async () => {
    const keySecret = "private-key-name";
    const valueSecret = "private-event-value";
    const items = [
      {
        id: "message-nested",
        type: "agent_message",
        text: `outer ${valueSecret}`,
        [`metadata-${keySecret}`]: {
          [keySecret]: `nested ${valueSecret}`,
        },
      },
    ] as unknown as CodexProviderRunResult["items"];
    const agent = new CodexAgent({
      provider: providerReturning("done", items),
      environment: {
        PRIVATE_KEY_NAME: keySecret,
        PRIVATE_EVENT_VALUE: valueSecret,
      },
      secretEnvironmentKeys: ["PRIVATE_KEY_NAME", "PRIVATE_EVENT_VALUE"],
    });

    const result = await agent.run({
      workingDirectory: "/project",
      prompt: "Analyze safely",
    });
    const surfaced = result.items[0] as unknown as Record<string, unknown>;
    const nested = surfaced[
      `metadata-${REDACTED_MARKER}`
    ] as Record<string, unknown>;

    expect(Object.keys(surfaced)).toContain(`metadata-${REDACTED_MARKER}`);
    expect(nested).toEqual({
      [REDACTED_MARKER]: `nested ${REDACTED_MARKER}`,
    });
    expect(JSON.stringify(result.items)).not.toContain(keySecret);
    expect(JSON.stringify(result.items)).not.toContain(valueSecret);
  });

  // Production break caught: independently replacing overlapping secrets can rematch modified text instead of selecting the longest original match once.
  it("redacts overlapping secrets longest-first without cascading", async () => {
    const agent = new CodexAgent({
      provider: providerReturning("token-extended token"),
      environment: {
        SHORT_TOKEN: "token",
        LONG_TOKEN: "token-extended",
      },
      secretEnvironmentKeys: ["SHORT_TOKEN", "LONG_TOKEN"],
    });

    const result = await agent.run({
      workingDirectory: "/project",
      prompt: "Analyze safely",
    });

    expect(result.finalResponse).toBe(
      `${REDACTED_MARKER} ${REDACTED_MARKER}`,
    );
  });

  // Production break caught: a fixed marker can equal or contain the configured secret and therefore surface the credential after replacement.
  it("selects a deterministic marker that does not contain a configured secret", async () => {
    const agent = new CodexAgent({
      provider: providerReturning("[REDACTED] REDACTED"),
      environment: {
        FULL_MARKER: "[REDACTED]",
        MARKER_CONTENT: "REDACTED",
      },
      secretEnvironmentKeys: ["FULL_MARKER", "MARKER_CONTENT"],
    });

    const result = await agent.run({
      workingDirectory: "/project",
      prompt: "Analyze safely",
    });

    expect(result.finalResponse).toBe(
      `${FILTERED_MARKER} ${FILTERED_MARKER}`,
    );
    expect(result.finalResponse).not.toContain("REDACTED");
  });

  // Production break caught: replacing one secret can join surrounding text to the beginning of a human-readable marker and form another configured secret.
  it("does not form a different secret across replacement boundaries", async () => {
    const reformedSecret = "a[R";
    const agent = new CodexAgent({
      provider: providerReturning("ax"),
      environment: {
        REPLACED_TOKEN: "x",
        REFORMED_TOKEN: reformedSecret,
      },
      secretEnvironmentKeys: ["REPLACED_TOKEN", "REFORMED_TOKEN"],
    });

    const result = await agent.run({
      workingDirectory: "/project",
      prompt: "Analyze safely",
    });

    expect(result.finalResponse).toBe(`a${REDACTED_MARKER}`);
    expect(result.finalResponse).not.toContain(reformedSecret);
  });

  // Production break caught: every normal marker may itself be a configured secret, requiring a safe empty replacement instead of leaking a marker value.
  it("falls back to an empty marker when every deterministic marker conflicts", async () => {
    const markerSecrets = {
      REDACTED_MARKER: "[REDACTED]",
      FILTERED_MARKER: "[FILTERED]",
      HIDDEN_MARKER: "<hidden>",
      MASKED_MARKER: "***",
      SEPARATOR_ONE: "\u2063",
      SEPARATOR_TWO: "\u2064",
      SEPARATOR_THREE: "\u2062",
      SEPARATOR_FOUR: "\u2061",
    };
    const agent = new CodexAgent({
      provider: providerReturning("[REDACTED]"),
      environment: markerSecrets,
      secretEnvironmentKeys: Object.keys(markerSecrets),
    });

    const result = await agent.run({
      workingDirectory: "/project",
      prompt: "Analyze safely",
    });

    expect(result.finalResponse).toBe("");
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
