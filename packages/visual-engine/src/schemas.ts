import type { FindingCategory, FindingSeverity } from "@design-sharingan/core";

export interface VisualFindingWireOutput {
  severity: FindingSeverity;
  category: FindingCategory;
  screen: string;
  description: string;
  evidence: string[];
  reason: string;
  recommendedAction: string;
}

export interface VisualAnalysisWireOutput {
  verification: {
    uxIntegrity: IntegrityVerification<"PASS" | "REGRESSION" | "NOT_VERIFIED">;
    productConsistency: IntegrityVerification<"PASS" | "REGRESSION" | "NOT_VERIFIED">;
    accessibility: IntegrityVerification<"PASS" | "REGRESSION" | "NOT_VERIFIED">;
    genomeIntegrity: IntegrityVerification<"PASS" | "CONFLICT" | "NOT_VERIFIED">;
  };
  findings: VisualFindingWireOutput[];
}

export interface IntegrityVerification<TStatus extends string> {
  status: TStatus;
  evidence: string[];
}

const boundedText = {
  type: "string",
  minLength: 1,
  maxLength: 2_000
} as const;

const findingSchema = {
  type: "object",
  properties: {
    severity: {
      type: "string",
      enum: ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"]
    },
    category: {
      type: "string",
      enum: [
        "HIERARCHY",
        "TYPOGRAPHY",
        "SPACING",
        "LAYOUT",
        "DENSITY",
        "COMPONENT",
        "COLOR",
        "MOTION",
        "ACCESSIBILITY",
        "RESPONSIVE",
        "GENOME"
      ]
    },
    screen: { type: "string", minLength: 1, maxLength: 512 },
    description: boundedText,
    evidence: {
      type: "array",
      items: boundedText,
      minItems: 1,
      maxItems: 16
    },
    reason: boundedText,
    recommendedAction: boundedText
  },
  required: [
    "severity",
    "category",
    "screen",
    "description",
    "evidence",
    "reason",
    "recommendedAction"
  ],
  additionalProperties: false
} as const;

export const VISUAL_ANALYSIS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verification: {
      type: "object",
      properties: {
        uxIntegrity: verificationSchema(["PASS", "REGRESSION", "NOT_VERIFIED"]),
        productConsistency: verificationSchema(["PASS", "REGRESSION", "NOT_VERIFIED"]),
        accessibility: verificationSchema(["PASS", "REGRESSION", "NOT_VERIFIED"]),
        genomeIntegrity: verificationSchema(["PASS", "CONFLICT", "NOT_VERIFIED"])
      },
      required: ["uxIntegrity", "productConsistency", "accessibility", "genomeIntegrity"],
      additionalProperties: false
    },
    findings: {
      type: "array",
      items: findingSchema,
      maxItems: 64
    }
  },
  required: ["verification", "findings"],
  additionalProperties: false
} as const;

function verificationSchema(statuses: readonly string[]) {
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: statuses },
      evidence: {
        type: "array",
        items: boundedText,
        minItems: 1,
        maxItems: 16
      }
    },
    required: ["status", "evidence"],
    additionalProperties: false
  } as const;
}

const severityValues = new Set(["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"]);
const categoryValues = new Set([
  "HIERARCHY",
  "TYPOGRAPHY",
  "SPACING",
  "LAYOUT",
  "DENSITY",
  "COMPONENT",
  "COLOR",
  "MOTION",
  "ACCESSIBILITY",
  "RESPONSIVE",
  "GENOME"
]);
const findingKeys = [
  "severity",
  "category",
  "screen",
  "description",
  "evidence",
  "reason",
  "recommendedAction"
] as const;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function boundedTextValue(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum
  );
}

function integrityVerification(
  value: unknown,
  statuses: ReadonlySet<string>
): boolean {
  return (
    exactRecord(value, ["status", "evidence"]) &&
    statuses.has(value.status as string) &&
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.length <= 16 &&
    value.evidence.every((entry) => boundedTextValue(entry, 2_000))
  );
}

export function assertVisualAnalysisWireOutput(
  value: unknown,
  expectedScreen: string
): VisualAnalysisWireOutput {
  if (
    !exactRecord(value, ["verification", "findings"]) ||
    !exactRecord(value.verification, [
      "uxIntegrity",
      "productConsistency",
      "accessibility",
      "genomeIntegrity"
    ]) ||
    !integrityVerification(
      value.verification.uxIntegrity,
      new Set(["PASS", "REGRESSION", "NOT_VERIFIED"])
    ) ||
    !integrityVerification(
      value.verification.productConsistency,
      new Set(["PASS", "REGRESSION", "NOT_VERIFIED"])
    ) ||
    !integrityVerification(
      value.verification.accessibility,
      new Set(["PASS", "REGRESSION", "NOT_VERIFIED"])
    ) ||
    !integrityVerification(
      value.verification.genomeIntegrity,
      new Set(["PASS", "CONFLICT", "NOT_VERIFIED"])
    ) ||
    !Array.isArray(value.findings) ||
    value.findings.length > 64 ||
    !value.findings.every(
      (finding) =>
        exactRecord(finding, findingKeys) &&
        severityValues.has(finding.severity as string) &&
        categoryValues.has(finding.category as string) &&
        finding.screen === expectedScreen &&
        boundedTextValue(finding.description, 2_000) &&
        Array.isArray(finding.evidence) &&
        finding.evidence.length > 0 &&
        finding.evidence.length <= 16 &&
        finding.evidence.every((entry) => boundedTextValue(entry, 2_000)) &&
        boundedTextValue(finding.reason, 2_000) &&
        boundedTextValue(finding.recommendedAction, 2_000)
    )
  ) {
    throw new Error("Codex returned invalid structured visual findings");
  }
  return value as unknown as VisualAnalysisWireOutput;
}
