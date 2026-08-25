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

const stringField = { type: "string" } as const;
const stringArrayField = {
  type: "array",
  items: { type: "string" },
} as const;

const nonEmptyStringArrayField = {
  ...stringArrayField,
  minItems: 1,
} as const;

export const SCAN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    hierarchy: stringField,
    layout: stringField,
    spacing: stringField,
    typography: stringField,
    colorLogic: stringField,
    componentGeometry: stringField,
    navigation: stringField,
    interaction: stringField,
    motion: stringField,
    density: stringField,
    emotionalTone: stringField,
    visualWeight: stringField,
    keep: stringArrayField,
    reject: stringArrayField,
    adapt: stringArrayField,
    invent: stringArrayField,
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
    area: stringField,
    severity: {
      type: "string",
      enum: ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"],
    },
    reason: stringField,
    affectedRoutes: stringArrayField,
    affectedComponents: stringArrayField,
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
    id: stringField,
    title: stringField,
    summary: stringField,
    recommended: { type: "boolean" },
    pros: nonEmptyStringArrayField,
    cons: nonEmptyStringArrayField,
    uxImpact: {
      type: "array",
      items: UX_IMPACT_OUTPUT_SCHEMA,
      minItems: 1,
    },
    estimatedComplexity: stringField,
    genomeFit: stringField,
    likelyFiles: nonEmptyStringArrayField,
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
    referenceIds: nonEmptyStringArrayField,
    role: stringField,
    principles: nonEmptyStringArrayField,
  },
  required: ["referenceIds", "role", "principles"],
  additionalProperties: false,
} as const;

export const ASSIMILATE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: stringField,
    sourceMap: {
      type: "array",
      items: ASSIMILATION_SOURCE_OUTPUT_SCHEMA,
      minItems: 2,
    },
    direction: SCAN_OUTPUT_SCHEMA,
  },
  required: ["summary", "sourceMap", "direction"],
  additionalProperties: false,
} as const;
