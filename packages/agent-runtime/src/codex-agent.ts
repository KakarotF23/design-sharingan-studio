import {
  Codex,
  type CodexOptions,
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
import { isDisabledCapabilityNotice, restrictedCodexRuntime } from "./capability-runtime";

export interface CodexProviderThreadOptions {
  workingDirectory: string;
  skipGitRepoCheck: boolean;
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
  createClient?(options: CodexOptions): Pick<Codex, "startThread" | "resumeThread"> | {
    startThread(options: SdkThreadOptions): { id: string | null; run(input: SdkInput, options: SdkTurnOptions): Promise<CodexProviderRunResult> };
    resumeThread(id: string, options: SdkThreadOptions): { id: string | null; run(input: SdkInput, options: SdkTurnOptions): Promise<CodexProviderRunResult> };
  };
}

class OfficialCodexProvider implements CodexProvider {
  constructor(private readonly client: NonNullable<ReturnType<NonNullable<CodexAgentConstructorOptions["createClient"]>>>, private readonly runtime: ReturnType<typeof restrictedCodexRuntime>) {}

  startThread(options: CodexProviderThreadOptions): CodexProviderThread {
    return this.wrapThread(this.client.startThread(this.threadOptions(options)));
  }

  resumeThread(
    threadId: string,
    options: CodexProviderThreadOptions,
  ): CodexProviderThread {
    this.runtime.requireOwnedThread(threadId);
    return this.wrapThread(
      this.client.resumeThread(threadId, this.threadOptions(options)),
    );
  }

  private threadOptions(options: CodexProviderThreadOptions): SdkThreadOptions {
    return {
      workingDirectory: options.workingDirectory,
      skipGitRepoCheck: options.skipGitRepoCheck,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      additionalDirectories: [],
    };
  }

  private wrapThread(
    thread: ReturnType<OfficialCodexProvider["client"]["startThread"]>,
  ): CodexProviderThread {
    const runtime = this.runtime;
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
        const result = await thread.run(sdkInput, turnOptions);
        const items = result.items.filter((item) => !isDisabledCapabilityNotice(item));
        const runtimeError = items.find((item) => item.type === "error");
        if (runtimeError?.type === "error") throw new Error(`Agent runtime rejected analysis: ${runtimeError.message}`);
        const forbidden = items.filter(({ type }) => !["agent_message", "reasoning", "todo_list"].includes(type));
        if (forbidden.length > 0) throw new Error(`Agent capability profile rejected a forbidden tool event (${forbidden.slice(0, 5).map(({ type }) => String(type).slice(0, 40)).join(", ")})`);
        if (thread.id) runtime.rememberThread(thread.id);
        return { ...result, items };
      },
    };
  }
}

export class CodexAgent {
  private readonly provider: CodexProvider;
  private readonly redact: (value: string) => string;

  constructor(options: CodexAgentConstructorOptions = {}) {
    const environment = options.environment ?? process.env;
    const runtime = options.provider === undefined ? restrictedCodexRuntime(environment) : undefined;
    this.provider = options.provider ?? new OfficialCodexProvider(options.createClient?.(runtime!.options) ?? new Codex(runtime!.options), runtime!);
    this.redact = createSecretRedactor(
      options.environment ?? process.env,
      options.secretEnvironmentKeys ?? Object.keys(environment).filter((key) => /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(key)),
    );
  }

  async run<TStructured = unknown>(
    input: CodexAgentRunInput,
  ): Promise<CodexAgentResult<TStructured>> {
    try {
      const threadOptions = {
        workingDirectory: input.workingDirectory,
        // Analysis may run from private V1 staging state rather than target code,
        // which intentionally is not required to be a Git checkout.
        skipGitRepoCheck: true,
      };
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
      const composedStack = surfaced.stack;
      if (composedStack !== undefined) {
        surfaced.stack = this.redact(composedStack);
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
