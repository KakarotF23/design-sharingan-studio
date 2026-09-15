import type { FeatureBrief } from "@design-sharingan/core";

function objectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function boundedList(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.trim().length > 0 &&
        entry.length <= maxItemLength,
    )
  );
}

export function parseFeatureBrief(value: unknown): FeatureBrief | undefined {
  if (!objectValue(value)) return undefined;
  const keys = [
    "name",
    "goal",
    "description",
    "constraints",
    "mustKeep",
    "mustNotChange",
    "successCriteria",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    !boundedString(value.name, 160) ||
    !boundedString(value.goal, 2_000) ||
    !boundedString(value.description, 4_000) ||
    !boundedList(value.constraints, 20, 1_000) ||
    !boundedList(value.mustKeep, 20, 1_000) ||
    !boundedList(value.mustNotChange, 20, 1_000) ||
    !boundedList(value.successCriteria, 20, 1_000)
  ) {
    return undefined;
  }
  return {
    name: value.name.trim(),
    goal: value.goal.trim(),
    description: value.description.trim(),
    constraints: value.constraints.map((entry) => entry.trim()),
    mustKeep: value.mustKeep.map((entry) => entry.trim()),
    mustNotChange: value.mustNotChange.map((entry) => entry.trim()),
    successCriteria: value.successCriteria.map((entry) => entry.trim()),
  };
}

export function lines(value: FormDataEntryValue | null): string[] {
  return typeof value === "string"
    ? value
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}
