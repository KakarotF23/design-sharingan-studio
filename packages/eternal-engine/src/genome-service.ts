import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createDenyByDefaultCodexAgent,
  type CodexAgentRunInput,
} from "@design-sharingan/agent-runtime";
import {
  initializeGenome,
  type GenomeInitAgent,
  type GenomeInitWireOutput,
  type InitializeGenomeInput,
  type InitializeGenomeResult,
} from "./init-genome";

export interface InitializeGenomeServiceOptions {
  agent?: GenomeInitAgent;
  createId?(): string;
}

function fakeAgent(input: InitializeGenomeInput): GenomeInitAgent {
  const catalog = input.representativeEvidence.flatMap((entry) => entry.evidence);
  const first = catalog[0];
  if (first === undefined) throw new Error("Fake Genome service requires representative evidence");
  const grounded = catalog.find(({ kind }) => kind !== "ROUTE") ?? first;
  const navigation = catalog.find(({ kind }) => kind === "NAVIGATION" || kind === "COMPONENT") ?? grounded;
  // A rendered product-consistency result is candidate evidence only. The
  // initializer may propose the rule, but it remains UNCONFIRMED until the
  // local user accepts its exact server-derived citation.
  const productLanguageEvidence = catalog.filter(({ kind }) => kind === "RENDER").at(-1);
  const routeFor = (evidenceId: string): string =>
    input.representativeEvidence.find(({ evidence }) =>
      evidence.some(({ id }) => id === evidenceId),
    )?.route ?? input.representativeEvidence[0]!.route;
  const confirmed = grounded.kind !== "ROUTE";
  const familyConfirmed = navigation.kind === "NAVIGATION" || navigation.kind === "COMPONENT";
  const output: GenomeInitWireOutput = {
    productIdentity: {
      statement: "A calm, local-first product with deliberate human design decisions.",
      confidence: confirmed ? "CONFIRMED" : "UNCONFIRMED",
      evidence: [grounded.id],
      scope: { routes: [routeFor(grounded.id)] },
    },
    rules: [
      {
        category: "UX_INVARIANT",
        statement: "Keep primary decisions explicit and reversible.",
        confidence: confirmed ? "CONFIRMED" : "UNCONFIRMED",
        evidence: [grounded.id],
        scope: { routes: [routeFor(grounded.id)] },
      },
      {
        category: "VISUAL_INVARIANT",
        statement: "Use restrained contrast to separate primary action from evidence.",
        confidence: "UNCONFIRMED",
        evidence: [first.id],
        scope: { routes: [routeFor(first.id)] },
      },
      ...(productLanguageEvidence === undefined ? [] : [{
        category: "VISUAL_INVARIANT" as const,
        statement: "Preserve the established product hierarchy and component language.",
        confidence: "CONFIRMED" as const,
        evidence: [productLanguageEvidence.id],
        scope: { routes: [routeFor(productLanguageEvidence.id)] },
      }]),
      {
        category: "ACCESSIBILITY_RULE",
        statement: "Preserve visible focus and readable contrast.",
        confidence: confirmed ? "CONFIRMED" : "UNCONFIRMED",
        evidence: [grounded.id],
        scope: { routes: [routeFor(grounded.id)] },
      },
      {
        category: "SCREEN_FAMILY",
        statement: "Project workspaces",
        confidence: familyConfirmed ? "CONFIRMED" : "UNCONFIRMED",
        evidence: [navigation.id],
        scope: { routes: [routeFor(navigation.id)] },
      },
      {
        category: "CONTENT_VOICE",
        statement: "Use calm, technical, and direct language.",
        confidence: confirmed ? "CONFIRMED" : "UNCONFIRMED",
        evidence: [grounded.id],
        scope: { routes: [routeFor(grounded.id)] },
      },
    ],
    screens: input.representativeEvidence.map(({ route }) => ({
      route,
      name: route === "/" ? "Home" : route.split("/").filter(Boolean).at(-1) ?? "Screen",
      family: "Project workspaces",
      inheritedRules: confirmed
        ? ["Keep primary decisions explicit and reversible.", "Preserve visible focus and readable contrast."]
        : [],
      exceptions: [],
      requiredStates: ["default", "loading", "error"],
    })),
  };
  return {
    async run<TStructured>(runInput: CodexAgentRunInput) {
      await writeFile(
        join(runInput.workingDirectory, "genome-agent-probe.tmp"),
        "Genome initialization analysis scratch.\n",
        { mode: 0o600 },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      return {
        threadId: "fake-genome-init-thread",
        finalResponse: JSON.stringify(output),
        structured: output as TStructured,
        items: [],
      };
    },
  };
}

export async function initializeGenomeWithCodex(
  input: InitializeGenomeInput,
  options: InitializeGenomeServiceOptions = {},
): Promise<InitializeGenomeResult> {
  const agent = options.agent ?? (
    process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1"
      ? fakeAgent(input)
      : createDenyByDefaultCodexAgent()
  );
  return initializeGenome(input, {
    agent,
    createId: options.createId ?? randomUUID,
  });
}
