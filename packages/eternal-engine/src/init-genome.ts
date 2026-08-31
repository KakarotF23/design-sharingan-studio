import type {
  CodexAgentResult,
  CodexAgentRunInput,
} from "@design-sharingan/agent-runtime";
import type {
  DesignGenome,
  GovernanceClaimCitation,
  GovernanceClaimCategory,
  GovernanceClaimScope,
  GovernanceInspectedScope,
  GovernanceVerifiedClaim,
  ScreenRecord,
} from "@design-sharingan/core";

export type GenomeRuleCategory =
  | "UX_INVARIANT"
  | "VISUAL_INVARIANT"
  | "MOTION_RULE"
  | "ACCESSIBILITY_RULE"
  | "COMPONENT_DNA"
  | "SCREEN_FAMILY"
  | "CONTENT_VOICE";

export type GenomeRuleConfidence = "CONFIRMED" | "UNCONFIRMED";

export interface GenomeInitProductIdentity {
  statement: string;
  confidence: GenomeRuleConfidence;
  evidence: string[];
  scope: GovernanceClaimScope;
}

export interface GenomeInitRule {
  category: GenomeRuleCategory;
  statement: string;
  confidence: GenomeRuleConfidence;
  evidence: string[];
  scope: GovernanceClaimScope;
}

export interface GenomeInitScreen {
  route: string;
  name: string;
  family: string;
  inheritedRules: string[];
  exceptions: string[];
  requiredStates: string[];
}

export interface GenomeInitWireOutput {
  productIdentity: GenomeInitProductIdentity;
  rules: GenomeInitRule[];
  screens: GenomeInitScreen[];
}

export interface GenomeProjectContext {
  projectId: string;
  name: string;
  framework?: string;
  routes: string[];
  componentDirectories: string[];
  designDocuments: string[];
}

export interface RepresentativeScreenEvidence {
  route: string;
  observations: string[];
  evidence: GovernanceEvidence[];
}

export interface GovernanceEvidence {
  id: string;
  kind: "RENDER" | "ROUTE" | "NAVIGATION" | "COMPONENT" | "TOKEN" | "DOCUMENT";
  excerpt: string;
  verifiedClaims?: GovernanceVerifiedClaim[];
}

export interface InitializeGenomeInput {
  workingDirectory: string;
  projectContext: GenomeProjectContext;
  representativeEvidence: RepresentativeScreenEvidence[];
}

export interface GenomeInitAgent {
  run<TStructured = unknown>(
    input: CodexAgentRunInput,
  ): Promise<CodexAgentResult<TStructured>>;
}

export interface InitializeGenomeDependencies {
  agent: GenomeInitAgent;
  createId(): string;
}

export interface InitializeGenomeResult {
  genome: DesignGenome;
  screens: ScreenRecord[];
  inspectedScope: GovernanceInspectedScope;
  claimCitations: GovernanceClaimCitation[];
  threadId: string;
}

const MAX_ITEMS = 64;
const MAX_TEXT = 1_000;
const EVIDENCE_ID_PATTERN = /^ev_[a-zA-Z0-9_-]{8,125}$/;
const SECRET_PATTERN = /(?:sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9]{12,}|AKIA[A-Z0-9]{12,}|Bearer\s+[a-zA-Z0-9._-]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+)/gi;
const PATH_PATTERN = /(?:\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+|[A-Za-z]:\\[^\s,;]+)/g;

export function scrubGovernanceText(value: string): string {
  return value.replace(SECRET_PATTERN, "[REDACTED]").replace(PATH_PATTERN, "[REDACTED]");
}

const boundedStringField = {
  type: "string",
  minLength: 1,
  maxLength: MAX_TEXT,
} as const;
const boundedStringArrayField = {
  type: "array",
  items: boundedStringField,
  maxItems: MAX_ITEMS,
} as const;
const evidenceField = {
  ...boundedStringArrayField,
  minItems: 1,
} as const;
const claimScopeField = {
  type: "object",
  properties: { routes: boundedStringArrayField },
  required: ["routes"],
  additionalProperties: false,
} as const;

export const GENOME_INIT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    productIdentity: {
      type: "object",
      properties: {
        statement: { ...boundedStringField, maxLength: 4_000 },
        confidence: { type: "string", enum: ["CONFIRMED", "UNCONFIRMED"] },
        evidence: evidenceField,
        scope: claimScopeField,
      },
      required: ["statement", "confidence", "evidence", "scope"],
      additionalProperties: false,
    },
    rules: {
      type: "array",
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "UX_INVARIANT",
              "VISUAL_INVARIANT",
              "MOTION_RULE",
              "ACCESSIBILITY_RULE",
              "COMPONENT_DNA",
              "SCREEN_FAMILY",
              "CONTENT_VOICE",
            ],
          },
          statement: boundedStringField,
          confidence: { type: "string", enum: ["CONFIRMED", "UNCONFIRMED"] },
          evidence: evidenceField,
          scope: claimScopeField,
        },
        required: ["category", "statement", "confidence", "evidence", "scope"],
        additionalProperties: false,
      },
    },
    screens: {
      type: "array",
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        properties: {
          route: { ...boundedStringField, maxLength: 512 },
          name: { ...boundedStringField, maxLength: 512 },
          family: { ...boundedStringField, maxLength: 512 },
          inheritedRules: boundedStringArrayField,
          exceptions: boundedStringArrayField,
          requiredStates: boundedStringArrayField,
        },
        required: [
          "route",
          "name",
          "family",
          "inheritedRules",
          "exceptions",
          "requiredStates",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["productIdentity", "rules", "screens"],
  additionalProperties: false,
} as const;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} does not match the exact initialization schema`);
  }
}

function boundedString(value: unknown, label: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function sanitizedString(value: unknown, label: string, max = MAX_TEXT): string {
  return scrubGovernanceText(boundedString(value, label, max));
}

function boundedArray(value: unknown, label: string, requireEvidence = false): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ITEMS ||
    (requireEvidence && value.length === 0)
  ) {
    throw new Error(`${label} must be a bounded${requireEvidence ? " non-empty" : ""} array`);
  }
  return value.map((entry, index) => boundedString(entry, `${label}[${index}]`));
}

function confidence(value: unknown, label: string): GenomeRuleConfidence {
  if (value !== "CONFIRMED" && value !== "UNCONFIRMED") {
    throw new Error(`${label} confidence is invalid`);
  }
  return value;
}

function claimScope(value: unknown, label: string): GovernanceClaimScope {
  const scope = objectValue(value, label);
  exactKeys(scope, ["routes"], label);
  const routes = boundedArray(scope.routes, `${label} routes`, true);
  if (new Set(routes).size !== routes.length) {
    throw new Error(`${label} routes must be unique`);
  }
  return { routes };
}

function parseWireOutput(value: unknown): GenomeInitWireOutput {
  const output = objectValue(value, "Genome initialization output");
  exactKeys(output, ["productIdentity", "rules", "screens"], "Genome initialization output");
  const identity = objectValue(output.productIdentity, "Product identity candidate");
  exactKeys(
    identity,
    ["statement", "confidence", "evidence", "scope"],
    "Product identity candidate",
  );
  if (!Array.isArray(output.rules) || output.rules.length > MAX_ITEMS) {
    throw new Error("Genome initialization rules must be bounded");
  }
  const categories = new Set<GenomeRuleCategory>([
    "UX_INVARIANT",
    "VISUAL_INVARIANT",
    "MOTION_RULE",
    "ACCESSIBILITY_RULE",
    "COMPONENT_DNA",
    "SCREEN_FAMILY",
    "CONTENT_VOICE",
  ]);
  const rules = output.rules.map((candidate, index) => {
    const rule = objectValue(candidate, `Genome rule ${index}`);
    exactKeys(rule, ["category", "statement", "confidence", "evidence", "scope"], `Genome rule ${index}`);
    if (!categories.has(rule.category as GenomeRuleCategory)) {
      throw new Error(`Genome rule ${index} category is invalid`);
    }
    return {
      category: rule.category as GenomeRuleCategory,
      statement: sanitizedString(rule.statement, `Genome rule ${index}`),
      confidence: confidence(rule.confidence, `Genome rule ${index}`),
      evidence: boundedArray(rule.evidence, `Genome rule ${index} evidence`, true),
      scope: claimScope(rule.scope, `Genome rule ${index} scope`),
    };
  });
  if (!Array.isArray(output.screens) || output.screens.length > MAX_ITEMS) {
    throw new Error("Genome initialization screens must be bounded");
  }
  const screens = output.screens.map((candidate, index) => {
    const screen = objectValue(candidate, `Initialized screen ${index}`);
    exactKeys(
      screen,
      ["route", "name", "family", "inheritedRules", "exceptions", "requiredStates"],
      `Initialized screen ${index}`,
    );
    return {
      route: boundedString(screen.route, `Initialized screen ${index} route`, 512),
      name: sanitizedString(screen.name, `Initialized screen ${index} name`, 512),
      family: sanitizedString(screen.family, `Initialized screen ${index} family`, 512),
      inheritedRules: boundedArray(
        screen.inheritedRules,
        `Initialized screen ${index} inherited rules`,
      ).map((value) => scrubGovernanceText(value)),
      exceptions: boundedArray(screen.exceptions, `Initialized screen ${index} exceptions`).map((value) => scrubGovernanceText(value)),
      requiredStates: boundedArray(
        screen.requiredStates,
        `Initialized screen ${index} required states`,
      ).map((value) => scrubGovernanceText(value)),
    };
  });
  return {
    productIdentity: {
      statement: sanitizedString(identity.statement, "Product identity candidate", 4_000),
      confidence: confidence(identity.confidence, "Product identity candidate"),
      evidence: boundedArray(identity.evidence, "Product identity evidence", true),
      scope: claimScope(identity.scope, "Product identity scope"),
    },
    rules,
    screens,
  };
}

function validateInput(input: InitializeGenomeInput): InitializeGenomeInput {
  if (!input.workingDirectory.startsWith("/")) {
    throw new Error("Genome initialization requires an authenticated absolute project path");
  }
  const context = input.projectContext;
  const projectId = boundedString(context.projectId, "Project identity", 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(projectId)) {
    throw new Error("Project identity is invalid");
  }
  const routes = boundedArray(context.routes, "Project routes");
  const routeSet = new Set(routes);
  if (
    !Array.isArray(input.representativeEvidence) ||
    input.representativeEvidence.length === 0 ||
    input.representativeEvidence.length > MAX_ITEMS
  ) {
    throw new Error("Genome initialization requires bounded representative evidence");
  }
  const representativeEvidence = input.representativeEvidence.map((entry, index) => {
    const route = boundedString(entry.route, `Representative evidence ${index} route`, 512);
    if (!routeSet.has(route)) {
      throw new Error("Representative evidence route is outside authenticated project context");
    }
    return {
      route,
      observations: boundedArray(
        entry.observations,
        `Representative evidence ${index} observations`,
        true,
      ).map((observation) => scrubGovernanceText(observation)),
      evidence: (() => {
        if (!Array.isArray(entry.evidence) || entry.evidence.length === 0 || entry.evidence.length > MAX_ITEMS) {
          throw new Error(`Representative evidence ${index} locators must be a bounded non-empty array`);
        }
        const kinds = new Set(["RENDER", "ROUTE", "NAVIGATION", "COMPONENT", "TOKEN", "DOCUMENT"]);
        return entry.evidence.map((candidate, evidenceIndex) => {
          const evidence = objectValue(candidate, `Representative evidence ${index}.${evidenceIndex}`);
          exactKeys(
            evidence,
            evidence.verifiedClaims === undefined
              ? ["id", "kind", "excerpt"]
              : ["id", "kind", "excerpt", "verifiedClaims"],
            `Representative evidence ${index}.${evidenceIndex}`,
          );
          const id = boundedString(evidence.id, `Evidence ${evidenceIndex} identity`, 128);
          if (!EVIDENCE_ID_PATTERN.test(id)) throw new Error("Representative evidence identity is not server controlled");
          if (!kinds.has(evidence.kind as string)) throw new Error("Representative evidence kind is invalid");
          const verifiedClaims = evidence.verifiedClaims === undefined
            ? []
            : (() => {
                if (!Array.isArray(evidence.verifiedClaims) || evidence.verifiedClaims.length > MAX_ITEMS) {
                  throw new Error("Verified evidence claims must be bounded");
                }
                return evidence.verifiedClaims.map((rawClaim, claimIndex) => {
                  const candidateClaim = objectValue(rawClaim, `Verified evidence claim ${claimIndex}`);
                  exactKeys(candidateClaim, ["claimType", "category", "statement", "scope"], `Verified evidence claim ${claimIndex}`);
                  const claimType = candidateClaim.claimType;
                  if (claimType !== "PRODUCT_IDENTITY" && claimType !== "RULE") {
                    throw new Error("Verified evidence claim type is invalid");
                  }
                  const claimCategory = candidateClaim.category;
                  const categories = new Set<GovernanceClaimCategory>([
                    "PRODUCT_IDENTITY", "UX_INVARIANT", "VISUAL_INVARIANT",
                    "MOTION_RULE", "ACCESSIBILITY_RULE", "COMPONENT_DNA",
                    "SCREEN_FAMILY", "CONTENT_VOICE",
                  ]);
                  if (!categories.has(claimCategory as GovernanceClaimCategory)) {
                    throw new Error("Verified evidence claim category is invalid");
                  }
                  if ((claimType === "PRODUCT_IDENTITY") !== (claimCategory === "PRODUCT_IDENTITY")) {
                    throw new Error("Verified evidence claim type and category are inconsistent");
                  }
                  const scope = claimScope(candidateClaim.scope, `Verified evidence claim ${claimIndex} scope`);
                  if (scope.routes.length !== 1 || scope.routes[0] !== route) {
                    throw new Error("Verified evidence claims cannot exceed their inspected route");
                  }
                  return {
                    claimType,
                    category: claimCategory as GovernanceClaimCategory,
                    statement: sanitizedString(candidateClaim.statement, `Verified evidence claim ${claimIndex}`),
                    scope,
                  } satisfies GovernanceVerifiedClaim;
                });
              })();
          return {
            id,
            kind: evidence.kind as GovernanceEvidence["kind"],
            excerpt: sanitizedString(evidence.excerpt, `Evidence ${evidenceIndex} excerpt`),
            ...(verifiedClaims.length === 0 ? {} : { verifiedClaims }),
          };
        });
      })(),
    };
  });
  if (new Set(representativeEvidence.map((entry) => entry.route)).size !== representativeEvidence.length) {
    throw new Error("Representative evidence routes must be unique");
  }
  const allEvidenceIds = representativeEvidence.flatMap((entry) => entry.evidence.map((evidence) => evidence.id));
  if (new Set(allEvidenceIds).size !== allEvidenceIds.length) {
    throw new Error("Representative evidence identities must be unique");
  }
  return {
    workingDirectory: input.workingDirectory,
    projectContext: {
      projectId,
      name: sanitizedString(context.name, "Project name", 512),
      ...(context.framework === undefined
        ? {}
        : { framework: sanitizedString(context.framework, "Project framework", 512) }),
      routes,
      componentDirectories: boundedArray(
        context.componentDirectories,
        "Component directories",
      ).map((value) => scrubGovernanceText(value)),
      designDocuments: boundedArray(context.designDocuments, "Design documents").map((value) => scrubGovernanceText(value)),
    },
    representativeEvidence,
  };
}

function buildPrompt(input: InitializeGenomeInput): string {
  const evidence = input.representativeEvidence
    .map(
      (entry) => `Representative ${entry.route} evidence:\nObservations: ${entry.observations.join(" | ")}\nServer evidence: ${entry.evidence.map((item) => `${item.id} [${item.kind}]: ${item.excerpt}`).join(" | ")}`,
    )
    .join("\n\n");
  return `Initialize a DRAFT Design Genome from authenticated local project context and representative current evidence only.

Project: ${input.projectContext.name}
Framework: ${input.projectContext.framework ?? "unknown"}
Known routes: ${input.projectContext.routes.join(", ")}
Component directories: ${input.projectContext.componentDirectories.join(", ") || "none detected"}
Design documents: ${input.projectContext.designDocuments.join(", ") || "none detected"}

${evidence}

Classify every proposed rule as CONFIRMED or UNCONFIRMED. Evidence from one representative screen is insufficient to create a whole-product invariant. Do not claim whole-product coverage, fabricate approval, invent evidence, or register routes absent from the representative evidence. Repeated drift is a decision candidate, never an automatic Genome rewrite. Return only the exact structured output.`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export async function initializeGenome(
  rawInput: InitializeGenomeInput,
  dependencies: InitializeGenomeDependencies,
): Promise<InitializeGenomeResult> {
  const input = validateInput(rawInput);
  const result = await dependencies.agent.run<GenomeInitWireOutput>({
    workingDirectory: input.workingDirectory,
    prompt: buildPrompt(input),
    outputSchema: GENOME_INIT_OUTPUT_SCHEMA,
  });
  const output = parseWireOutput(result.structured);
  const evidenceByRoute = new Map(
    input.representativeEvidence.map((entry) => [entry.route, entry]),
  );
  const outputRoutes = output.screens.map((screen) => screen.route);
  if (
    outputRoutes.length !== evidenceByRoute.size ||
    new Set(outputRoutes).size !== outputRoutes.length ||
    outputRoutes.some((route) => !evidenceByRoute.has(route))
  ) {
    throw new Error("Initialized screens must exactly match representative evidence coverage");
  }

  const evidenceCatalog = new Map(
    input.representativeEvidence.flatMap((entry) => entry.evidence.map((evidence) => [evidence.id, evidence] as const)),
  );
  const routeByEvidence = new Map(
    input.representativeEvidence.flatMap((entry) =>
      entry.evidence.map((evidence) => [evidence.id, entry.route] as const)),
  );
  const verifiedClaim = (
    claimType: GovernanceVerifiedClaim["claimType"],
    category: GovernanceClaimCategory,
    confidenceValue: GenomeRuleConfidence,
    citations: string[],
    statement: string,
    scope: GovernanceClaimScope,
  ): boolean => {
    if (confidenceValue !== "CONFIRMED" || citations.some((id) => !evidenceCatalog.has(id))) return false;
    const citedRoutes = unique(citations.flatMap((id) => {
      const route = routeByEvidence.get(id);
      return route === undefined ? [] : [route];
    })).sort();
    if (JSON.stringify([...scope.routes].sort()) !== JSON.stringify(citedRoutes)) return false;
    return citations.every((id) => {
      const evidence = evidenceCatalog.get(id);
      const route = routeByEvidence.get(id);
      return evidence !== undefined && route !== undefined &&
        (evidence.verifiedClaims ?? []).some((claim) =>
          claim.claimType === claimType && claim.category === category &&
          claim.statement === statement && claim.scope.routes.length === 1 &&
          claim.scope.routes[0] === route,
        );
    });
  };
  const auditedScope = (citations: string[]): GovernanceClaimScope => {
    const routes = unique(citations.flatMap((id) => {
      const route = routeByEvidence.get(id);
      return route === undefined ? [] : [route];
    }));
    return { routes };
  };
  const claimCitations: GovernanceClaimCitation[] = [];
  const normalizedRules = output.rules.map((rule) => {
    const statement = sanitizedString(rule.statement, "Genome rule");
    const evidenceIds = rule.evidence.filter((id) => evidenceCatalog.has(id));
    const normalizedConfidence = verifiedClaim(
      "RULE", rule.category, rule.confidence, evidenceIds, statement, rule.scope,
    ) ? "CONFIRMED" as const : "UNCONFIRMED" as const;
    claimCitations.push({
      claimType: "RULE",
      category: rule.category,
      statement,
      confidence: normalizedConfidence,
      requestedConfidence: rule.confidence,
      scope: auditedScope(evidenceIds),
      evidenceIds,
    });
    return { ...rule, statement, evidence: evidenceIds, confidence: normalizedConfidence };
  });
  const confirmed = normalizedRules.filter((rule) => rule.confidence === "CONFIRMED");
  const confirmedStatements = new Set(confirmed.map((rule) => rule.statement));
  const unconfirmed = normalizedRules
    .filter((rule) => rule.confidence === "UNCONFIRMED")
    .map((rule) => rule.statement);
  const identityEvidenceIds = output.productIdentity.evidence.filter((id) => evidenceCatalog.has(id));
  const identityConfirmed = verifiedClaim(
    "PRODUCT_IDENTITY", "PRODUCT_IDENTITY", output.productIdentity.confidence,
    identityEvidenceIds, output.productIdentity.statement, output.productIdentity.scope,
  );
  claimCitations.push({
    claimType: "PRODUCT_IDENTITY",
    category: "PRODUCT_IDENTITY",
    statement: sanitizedString(output.productIdentity.statement, "Product identity", 4_000),
    confidence: identityConfirmed ? "CONFIRMED" : "UNCONFIRMED",
    requestedConfidence: output.productIdentity.confidence,
    scope: auditedScope(identityEvidenceIds),
    evidenceIds: identityEvidenceIds,
  });
  if (output.productIdentity.confidence === "UNCONFIRMED") {
    unconfirmed.push(sanitizedString(output.productIdentity.statement, "Product identity"));
  } else if (!identityConfirmed) {
    unconfirmed.push(sanitizedString(output.productIdentity.statement, "Product identity"));
  }

  const confirmedFamilies = new Set(
    confirmed
      .filter((rule) => rule.category === "SCREEN_FAMILY")
      .map((rule) => rule.statement),
  );
  const screens = output.screens.map((screen) => {
    const evidence = evidenceByRoute.get(screen.route);
    if (evidence === undefined) {
      throw new Error("Initialized screen is outside representative evidence coverage");
    }
    const unknownInherited = screen.inheritedRules.filter(
      (rule) => !confirmedStatements.has(rule),
    );
    unconfirmed.push(...unknownInherited, ...screen.exceptions);
    const family = confirmedFamilies.has(screen.family) ? screen.family : "UNCONFIRMED";
    if (family === "UNCONFIRMED") {
      unconfirmed.push(`Screen family candidate: ${screen.family}`);
    }
    return {
      id: boundedString(dependencies.createId(), "Screen identity", 128),
      route: screen.route,
      name: screen.name,
      family,
      inheritedRules: screen.inheritedRules.filter((rule) => confirmedStatements.has(rule)),
      exceptions: [],
      requiredStates: screen.requiredStates,
      evidence: evidence.evidence.map((item) => item.id),
      driftStatus: "NOT_VERIFIED",
    } satisfies ScreenRecord;
  });

  const rulesFor = (category: GenomeRuleCategory): string[] =>
    unique(
      confirmed
        .filter((rule) => rule.category === category)
        .map((rule) => rule.statement),
    );
  const genome: DesignGenome = {
    version: "0.1.0",
    status: "DRAFT",
    productIdentity: identityConfirmed
      ? sanitizedString(output.productIdentity.statement, "Product identity", 4_000)
      : "Product identity is not yet confirmed from representative evidence.",
    uxInvariants: rulesFor("UX_INVARIANT"),
    visualInvariants: rulesFor("VISUAL_INVARIANT"),
    motionRules: rulesFor("MOTION_RULE"),
    accessibilityRules: rulesFor("ACCESSIBILITY_RULE"),
    componentDNA: rulesFor("COMPONENT_DNA"),
    screenFamilies: rulesFor("SCREEN_FAMILY"),
    contentVoice: rulesFor("CONTENT_VOICE"),
    intentionalExceptions: [],
    unconfirmedRules: unique([
      ...unconfirmed,
      "Representative evidence does not establish whole-product coverage.",
    ]),
  };
  const inspectedScope: GovernanceInspectedScope = {
    representative: true,
    routes: input.representativeEvidence.map(({ route }) => route),
    evidenceIds: input.representativeEvidence.flatMap(({ evidence }) =>
      evidence.map(({ id }) => id)),
  };
  return { genome, screens, inspectedScope, claimCitations, threadId: result.threadId };
}
