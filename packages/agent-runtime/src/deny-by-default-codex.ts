import {
  Codex,
  type CodexOptions,
  type Input as SdkInput,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import {
  CodexAgent,
  type CodexProvider,
  type CodexProviderRunResult,
  type CodexProviderThread,
} from "./codex-agent";
import type { CodexAgentOptions } from "./types";

export type DenyByDefaultCodexClientOptions = Pick<CodexOptions, "env">;

export interface DenyByDefaultCodexClientThread {
  readonly id: string | null;
  runStreamed(input: SdkInput, options?: TurnOptions): Promise<{
    events: AsyncGenerator<ThreadEvent>;
  }>;
}

export interface DenyByDefaultCodexClient {
  startThread(options?: ThreadOptions): DenyByDefaultCodexClientThread;
  resumeThread(id: string, options?: ThreadOptions): DenyByDefaultCodexClientThread;
}

export interface DenyByDefaultCodexAgentOptions extends CodexAgentOptions {
  client?: DenyByDefaultCodexClient;
  createClient?(options: DenyByDefaultCodexClientOptions): DenyByDefaultCodexClient;
  environment?: Readonly<Record<string, string | undefined>>;
}

const ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "CODEX_HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

const THREAD_OPTIONS = {
  sandboxMode: "read-only",
  approvalPolicy: "never",
  additionalDirectories: [],
  skipGitRepoCheck: true,
  networkAccessEnabled: false,
  webSearchMode: "disabled",
} as const satisfies Omit<ThreadOptions, "workingDirectory">;

const FORBIDDEN_ITEM_TYPES = new Set<ThreadItem["type"]>([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
]);
const SAFE_ITEM_TYPES = new Set<ThreadItem["type"]>([
  "agent_message",
  "reasoning",
  "todo_list",
]);

function minimalEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const entries = ENVIRONMENT_ALLOWLIST.flatMap((key) => {
    const value = source[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  return Object.fromEntries(entries);
}

class DenyByDefaultCodexProvider implements CodexProvider {
  constructor(private readonly client: DenyByDefaultCodexClient) {}

  startThread(options: { workingDirectory: string }): CodexProviderThread {
    const thread = this.client.startThread({
      workingDirectory: options.workingDirectory,
      ...THREAD_OPTIONS,
    });
    return this.wrap(thread);
  }

  resumeThread(): CodexProviderThread {
    throw new Error("Eternal Codex analysis must not resume an ambient thread");
  }

  private wrap(thread: DenyByDefaultCodexClientThread): CodexProviderThread {
    return {
      get id() {
        return thread.id;
      },
      async run(input, options) {
        if (input.images.length !== 0) {
          throw new Error("Eternal Codex local image attachments are forbidden");
        }
        const sdkInput: SdkInput = [{ type: "text", text: input.prompt }];
        const streamed = await thread.runStreamed(sdkInput, {
          ...(options.outputSchema === undefined
            ? {}
            : { outputSchema: options.outputSchema }),
        });
        const items: ThreadItem[] = [];
        let finalResponse = "";
        for await (const event of streamed.events) {
          if (
            (event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed")
          ) {
            if (event.item.type === "error") throw new Error(event.item.message);
            if (
              FORBIDDEN_ITEM_TYPES.has(event.item.type) ||
              !SAFE_ITEM_TYPES.has(event.item.type)
            ) {
              throw new Error(
                `Eternal Codex analysis emitted forbidden ${event.item.type} event`,
              );
            }
          }
          if (event.type === "turn.failed" || event.type === "error") {
            throw new Error(
              event.type === "turn.failed" ? event.error.message : event.message,
            );
          }
          if (event.type === "item.completed") {
            items.push(event.item);
            if (event.item.type === "agent_message") {
              finalResponse = event.item.text;
            }
          }
        }
        return { finalResponse, items } satisfies CodexProviderRunResult;
      },
    };
  }
}

export function createDenyByDefaultCodexAgent(
  options: DenyByDefaultCodexAgentOptions = {},
): CodexAgent {
  const environment = options.environment ?? process.env;
  const clientOptions: DenyByDefaultCodexClientOptions = {
    env: minimalEnvironment(environment),
  };
  const client = options.client ?? (
    options.createClient?.(clientOptions) ?? new Codex(clientOptions)
  );
  return new CodexAgent({
    provider: new DenyByDefaultCodexProvider(client),
    environment,
    secretEnvironmentKeys: options.secretEnvironmentKeys ?? [
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
    ],
  });
}
