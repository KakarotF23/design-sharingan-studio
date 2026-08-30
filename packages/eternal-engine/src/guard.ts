import type { DesignGenome, FeatureBrief } from "@design-sharingan/core";

export type GenomeAuthority = "AUTHORITATIVE" | "NON_AUTHORITATIVE";
export type GuardDisposition = "INHERIT" | "EXTEND" | "DECIDE" | "REJECT" | "VERIFY";

export interface RepeatedPatternEvidence {
  rule: string;
  screens: string[];
  classification: "DRIFT" | "CANDIDATE_EVOLUTION";
}

export interface GuardFeatureInput {
  genome: DesignGenome;
  featureBrief: FeatureBrief;
  repeatedPatterns?: RepeatedPatternEvidence[];
}

export interface FeatureGuardResult {
  genomeAuthority: GenomeAuthority;
  INHERIT: string[];
  EXTEND: string[];
  DECIDE: string[];
  REJECT: string[];
  VERIFY: string[];
}

const MAX_ITEMS = 64;
const MAX_ITEM_LENGTH = 1_000;

function boundedString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_ITEM_LENGTH
  ) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function boundedList(values: unknown, label: string): string[] {
  if (!Array.isArray(values) || values.length > MAX_ITEMS) {
    throw new Error(`${label} must be a bounded array`);
  }
  return values.map((value, index) => boundedString(value, `${label}[${index}]`));
}

function uniqueBounded(values: readonly string[], label: string): string[] {
  const unique = [...new Set(values)];
  if (unique.length > MAX_ITEMS) {
    throw new Error(`${label} exceeds the guard output limit`);
  }
  return unique.map((value, index) => boundedString(value, `${label}[${index}]`));
}

function assertFeatureBrief(featureBrief: FeatureBrief): FeatureBrief {
  return {
    name: boundedString(featureBrief.name, "Feature name"),
    goal: boundedString(featureBrief.goal, "Feature goal"),
    description: boundedString(featureBrief.description, "Feature description"),
    constraints: boundedList(featureBrief.constraints, "Feature constraints"),
    mustKeep: boundedList(featureBrief.mustKeep, "Feature must-keep rules"),
    mustNotChange: boundedList(
      featureBrief.mustNotChange,
      "Feature protected rules",
    ),
    successCriteria: boundedList(
      featureBrief.successCriteria,
      "Feature success criteria",
    ),
  };
}

function assertGenome(genome: DesignGenome): DesignGenome {
  if (genome.status !== "DRAFT" && genome.status !== "APPROVED") {
    throw new Error("Genome status is invalid");
  }
  return {
    version: boundedString(genome.version, "Genome version"),
    status: genome.status,
    productIdentity: boundedString(genome.productIdentity, "Product identity"),
    uxInvariants: boundedList(genome.uxInvariants, "UX invariants"),
    visualInvariants: boundedList(genome.visualInvariants, "Visual invariants"),
    motionRules: boundedList(genome.motionRules, "Motion rules"),
    accessibilityRules: boundedList(
      genome.accessibilityRules,
      "Accessibility rules",
    ),
    componentDNA: boundedList(genome.componentDNA, "Component DNA"),
    screenFamilies: boundedList(genome.screenFamilies, "Screen families"),
    contentVoice: boundedList(genome.contentVoice, "Content voice"),
    intentionalExceptions: boundedList(
      genome.intentionalExceptions,
      "Intentional exceptions",
    ),
    unconfirmedRules: boundedList(genome.unconfirmedRules, "Unconfirmed rules"),
  };
}

function assertRepeatedPatterns(
  patterns: readonly RepeatedPatternEvidence[] | undefined,
): RepeatedPatternEvidence[] {
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns) || patterns.length > MAX_ITEMS) {
    throw new Error("Repeated pattern evidence must be bounded");
  }
  return patterns.map((pattern, index) => {
    if (
      pattern.classification !== "DRIFT" &&
      pattern.classification !== "CANDIDATE_EVOLUTION"
    ) {
      throw new Error(`Repeated pattern ${index} has an invalid classification`);
    }
    const screens = boundedList(pattern.screens, `Repeated pattern ${index} screens`);
    if (screens.length < 2) {
      throw new Error("Repeated pattern evidence must cover at least two screens");
    }
    return {
      rule: boundedString(pattern.rule, `Repeated pattern ${index} rule`),
      screens,
      classification: pattern.classification,
    };
  });
}

export async function guardFeature(
  input: GuardFeatureInput,
): Promise<FeatureGuardResult> {
  const genome = assertGenome(input.genome);
  const featureBrief = assertFeatureBrief(input.featureBrief);
  const repeatedPatterns = assertRepeatedPatterns(input.repeatedPatterns);
  const authoritative = genome.status === "APPROVED";
  const inheritedCandidates = [
    ...genome.uxInvariants,
    ...genome.visualInvariants,
    ...genome.motionRules,
    ...genome.accessibilityRules,
    ...genome.componentDNA,
    ...genome.contentVoice,
  ];

  return assertGuardResult({
    genomeAuthority: authoritative ? "AUTHORITATIVE" : "NON_AUTHORITATIVE",
    INHERIT: authoritative ? inheritedCandidates : [],
    EXTEND: [
      ...featureBrief.constraints,
      ...featureBrief.mustKeep,
      ...(authoritative ? genome.intentionalExceptions : []),
    ],
    DECIDE: [
      ...genome.unconfirmedRules,
      ...repeatedPatterns.map((pattern) => pattern.rule),
      ...(authoritative ? [] : inheritedCandidates),
    ],
    REJECT: featureBrief.mustNotChange,
    VERIFY: [
      ...featureBrief.successCriteria,
      "Capture fresh rendered evidence for the affected screens and states.",
    ],
  });
}

export function assertGuardResult(value: FeatureGuardResult): FeatureGuardResult {
  const keys = [
    "genomeAuthority",
    "INHERIT",
    "EXTEND",
    "DECIDE",
    "REJECT",
    "VERIFY",
  ];
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    (value.genomeAuthority !== "AUTHORITATIVE" &&
      value.genomeAuthority !== "NON_AUTHORITATIVE")
  ) {
    throw new Error("Feature guard output does not match the exact schema");
  }
  return {
    genomeAuthority: value.genomeAuthority,
    INHERIT: uniqueBounded(value.INHERIT, "INHERIT"),
    EXTEND: uniqueBounded(value.EXTEND, "EXTEND"),
    DECIDE: uniqueBounded(value.DECIDE, "DECIDE"),
    REJECT: uniqueBounded(value.REJECT, "REJECT"),
    VERIFY: uniqueBounded(value.VERIFY, "VERIFY"),
  };
}
