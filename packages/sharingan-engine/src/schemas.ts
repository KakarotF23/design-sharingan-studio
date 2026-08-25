export interface ScanWireOutput {
  hierarchy: string;
  layout: string;
  spacing: string;
  typography: string;
  colorLogic: string;
  componentGeometry: string;
  navigation: string;
  interaction: string;
  motion: string;
  density: string;
  emotionalTone: string;
  visualWeight: string;
  keep: string[];
  reject: string[];
  adapt: string[];
  invent: string[];
}

export interface UXImpactWireOutput {
  area: string;
  severity: "CRITICAL" | "IMPORTANT" | "POLISH" | "IGNORE";
  reason: string;
  affectedRoutes: string[];
  affectedComponents: string[];
  decisionRequired: boolean;
}

export interface DesignApproachWireOutput {
  id: string;
  title: string;
  summary: string;
  recommended: boolean;
  pros: string[];
  cons: string[];
  uxImpact: UXImpactWireOutput[];
  estimatedComplexity: string;
  genomeFit: string;
  likelyFiles: string[];
  status: "PROPOSED";
}

export interface EvolveStructuredOutput {
  uxImpact: UXImpactWireOutput[];
  approaches: DesignApproachWireOutput[];
}

export interface AssimilationSourceWireOutput {
  referenceIds: string[];
  role: string;
  principles: string[];
}

export interface AssimilateWireOutput {
  summary: string;
  sourceMap: AssimilationSourceWireOutput[];
  direction: ScanWireOutput;
}

const analysisStringField = {
  type: "string",
  minLength: 1,
  maxLength: 2_000,
} as const;
const shortStringField = {
  type: "string",
  minLength: 1,
  maxLength: 256,
} as const;
const identifierStringField = {
  type: "string",
  minLength: 1,
  maxLength: 128,
} as const;
const decisionStringArrayField = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 1_000 },
  maxItems: 12,
} as const;

const nonEmptyDecisionStringArrayField = {
  ...decisionStringArrayField,
  minItems: 1,
} as const;

const locatorStringArrayField = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 512 },
  maxItems: 16,
} as const;

export const SCAN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    hierarchy: analysisStringField,
    layout: analysisStringField,
    spacing: analysisStringField,
    typography: analysisStringField,
    colorLogic: analysisStringField,
    componentGeometry: analysisStringField,
    navigation: analysisStringField,
    interaction: analysisStringField,
    motion: analysisStringField,
    density: analysisStringField,
    emotionalTone: analysisStringField,
    visualWeight: analysisStringField,
    keep: decisionStringArrayField,
    reject: decisionStringArrayField,
    adapt: decisionStringArrayField,
    invent: decisionStringArrayField,
  },
  required: [
    "hierarchy",
    "layout",
    "spacing",
    "typography",
    "colorLogic",
    "componentGeometry",
    "navigation",
    "interaction",
    "motion",
    "density",
    "emotionalTone",
    "visualWeight",
    "keep",
    "reject",
    "adapt",
    "invent",
  ],
  additionalProperties: false,
} as const;

const UX_IMPACT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    area: shortStringField,
    severity: {
      type: "string",
      enum: ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"],
    },
    reason: analysisStringField,
    affectedRoutes: locatorStringArrayField,
    affectedComponents: locatorStringArrayField,
    decisionRequired: { type: "boolean" },
  },
  required: [
    "area",
    "severity",
    "reason",
    "affectedRoutes",
    "affectedComponents",
    "decisionRequired",
  ],
  additionalProperties: false,
} as const;

const DESIGN_APPROACH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: identifierStringField,
    title: shortStringField,
    summary: analysisStringField,
    recommended: { type: "boolean" },
    pros: nonEmptyDecisionStringArrayField,
    cons: nonEmptyDecisionStringArrayField,
    uxImpact: {
      type: "array",
      items: UX_IMPACT_OUTPUT_SCHEMA,
      minItems: 1,
      maxItems: 8,
    },
    estimatedComplexity: shortStringField,
    genomeFit: analysisStringField,
    likelyFiles: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 512 },
      minItems: 1,
      maxItems: 32,
    },
    status: { type: "string", enum: ["PROPOSED"] },
  },
  required: [
    "id",
    "title",
    "summary",
    "recommended",
    "pros",
    "cons",
    "uxImpact",
    "estimatedComplexity",
    "genomeFit",
    "likelyFiles",
    "status",
  ],
  additionalProperties: false,
} as const;

export const EVOLVE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    uxImpact: {
      type: "array",
      items: UX_IMPACT_OUTPUT_SCHEMA,
      minItems: 1,
      maxItems: 8,
    },
    approaches: {
      type: "array",
      items: DESIGN_APPROACH_OUTPUT_SCHEMA,
      minItems: 2,
      maxItems: 3,
    },
  },
  required: ["uxImpact", "approaches"],
  additionalProperties: false,
} as const;

const ASSIMILATION_SOURCE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    referenceIds: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 128 },
      minItems: 1,
      maxItems: 32,
    },
    role: shortStringField,
    principles: nonEmptyDecisionStringArrayField,
  },
  required: ["referenceIds", "role", "principles"],
  additionalProperties: false,
} as const;

export const ASSIMILATE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 4_000 },
    sourceMap: {
      type: "array",
      items: ASSIMILATION_SOURCE_OUTPUT_SCHEMA,
      minItems: 2,
      maxItems: 16,
    },
    direction: SCAN_OUTPUT_SCHEMA,
  },
  required: ["summary", "sourceMap", "direction"],
  additionalProperties: false,
} as const;
