import {
  Codex,
  type Input as SdkInput,
  type ThreadItem,
  type ThreadOptions as SdkThreadOptions,
  type TurnOptions as SdkTurnOptions,
} from "@openai/codex-sdk";
import type {
  CodexAgentOptions,
  CodexAgentResult,
  CodexAgentRunInput,
  JsonSchema,
} from "./types";

export interface CodexProviderThreadOptions {
  workingDirectory: string;
}

export interface CodexProviderRunInput {
  prompt: string;
  images: readonly string[];
}

export interface CodexProviderRunOptions {
  outputSchema?: JsonSchema;
}

export interface CodexProviderRunResult {
  finalResponse: string;
  items: ThreadItem[];
}

export interface CodexProviderThread {
  readonly id: string | null;
  run(
    input: CodexProviderRunInput,
    options: CodexProviderRunOptions,
  ): Promise<CodexProviderRunResult>;
}

export interface CodexProvider {
  startThread(options: CodexProviderThreadOptions): CodexProviderThread;
  resumeThread(
    threadId: string,
    options: CodexProviderThreadOptions,
  ): CodexProviderThread;
}

export interface CodexAgentConstructorOptions extends CodexAgentOptions {
  provider?: CodexProvider;
}

class OfficialCodexProvider implements CodexProvider {
  constructor(private readonly client: Codex) {}

  startThread(options: CodexProviderThreadOptions): CodexProviderThread {
    return this.wrapThread(this.client.startThread(this.threadOptions(options)));
  }

  resumeThread(
    threadId: string,
    options: CodexProviderThreadOptions,
  ): CodexProviderThread {
    return this.wrapThread(
      this.client.resumeThread(threadId, this.threadOptions(options)),
    );
  }

  private threadOptions(options: CodexProviderThreadOptions): SdkThreadOptions {
    return { workingDirectory: options.workingDirectory };
  }

  private wrapThread(
    thread: ReturnType<Codex["startThread"]>,
  ): CodexProviderThread {
    return {
      get id() {
        return thread.id;
      },
      async run(input, options) {
        const sdkInput: SdkInput = [
          { type: "text", text: input.prompt },
          ...input.images.map((path) => ({
            type: "local_image" as const,
            path,
          })),
        ];
        const turnOptions: SdkTurnOptions = {
          ...(options.outputSchema === undefined
            ? {}
            : { outputSchema: options.outputSchema }),
        };
        return thread.run(sdkInput, turnOptions);
      },
    };
  }
}

export class CodexAgent {
  private readonly provider: CodexProvider;
  private readonly redact: (value: string) => string;

  constructor(options: CodexAgentConstructorOptions = {}) {
    this.provider = options.provider ?? new OfficialCodexProvider(new Codex());
    this.redact = createSecretRedactor(
      options.environment ?? process.env,
      options.secretEnvironmentKeys ?? [],
    );
  }

  async run<TStructured = unknown>(
    input: CodexAgentRunInput,
  ): Promise<CodexAgentResult<TStructured>> {
    try {
      const threadOptions = { workingDirectory: input.workingDirectory };
      const thread = input.threadId
        ? this.provider.resumeThread(input.threadId, threadOptions)
        : this.provider.startThread(threadOptions);
      const turn = await thread.run(
        { prompt: input.prompt, images: input.images ?? [] },
        {
          ...(input.outputSchema === undefined
            ? {}
            : { outputSchema: input.outputSchema }),
        },
      );
      const threadId = thread.id ?? input.threadId;

      if (!threadId) {
        throw new Error("Codex did not return a thread id.");
      }

      const structured =
        input.outputSchema === undefined
          ? null
          : (redactValue(
              JSON.parse(turn.finalResponse),
              this.redact,
            ) as TStructured);
      const finalResponse =
        input.outputSchema === undefined
          ? this.redact(turn.finalResponse)
          : JSON.stringify(structured);

      return {
        threadId,
        finalResponse,
        structured,
        items: redactValue(turn.items, this.redact) as ThreadItem[],
      };
    } catch (error) {
      const surfaced = new Error(
        this.redact(error instanceof Error ? error.message : String(error)),
      );
      if (error instanceof Error) {
        surfaced.name = this.redact(error.name);
      }
      throw surfaced;
    }
  }
}

function createSecretRedactor(
  environment: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): (value: string) => string {
  const secrets = [
    ...new Set(
      keys
        .map((key) => environment[key])
        .filter((value): value is string => value !== undefined && value !== ""),
    ),
  ];
  const alternatives = [
    ...new Set(
      secrets.flatMap((secret) => {
        const encoded = JSON.stringify(secret);
        return [encoded, encoded.slice(1, -1), secret];
      }),
    ),
  ].filter((value) => value !== "");

  alternatives.sort((left, right) => {
    const byLength = right.length - left.length;
    if (byLength !== 0) {
      return byLength;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  });

  if (alternatives.length === 0) {
    return (value) => value;
  }

  const marker = selectSafeMarker(alternatives);
  const matcher = new RegExp(alternatives.map(escapeRegExp).join("|"), "g");

  return (value) => {
    const redacted = value.replace(matcher, () => marker);
    return alternatives.some((secret) => redacted.includes(secret))
      ? ""
      : redacted;
  };
}

function selectSafeMarker(secrets: readonly string[]): string {
  const separators = ["\u2063", "\u2064", "\u2062", "\u2061"];
  const labels = ["[REDACTED]", "[FILTERED]", "<hidden>", "***"];

  for (const separator of separators) {
    if (secrets.some((secret) => secret.includes(separator))) {
      continue;
    }

    for (const label of labels) {
      const candidate = `${separator}${label}${separator}`;
      if (secrets.every((secret) => !candidate.includes(secret))) {
        return candidate;
      }
    }
  }

  return "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactValue(
  value: unknown,
  redact: (value: string) => string,
): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, redact));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redact(key),
        redactValue(entry, redact),
      ]),
    );
  }
  return value;
}
