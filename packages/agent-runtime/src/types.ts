import type { ThreadItem } from "@openai/codex-sdk";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface CodexAgentRunInput {
  capabilityProfile?: "ANALYSIS" | "MUTATION_MIRROR";
  workingDirectory: string;
  prompt: string;
  images?: readonly string[];
  outputSchema?: JsonSchema;
  threadId?: string;
}

export interface CodexAgentResult<TStructured = unknown> {
  threadId: string;
  finalResponse: string;
  structured: TStructured | null;
  items: ThreadItem[];
}

export interface CodexAgentOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  secretEnvironmentKeys?: readonly string[];
}
