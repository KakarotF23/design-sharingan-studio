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

const stringField = { type: "string" } as const;
const stringArrayField = {
  type: "array",
  items: { type: "string" },
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
