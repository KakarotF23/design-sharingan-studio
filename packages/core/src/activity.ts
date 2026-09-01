import type { ISODateTime } from "./domain";

const ACTIVITY_CATEGORIES = [
  "SYSTEM",
  "AGENT",
  "APPROVAL",
  "RENDER",
  "GIT",
  "GOVERNANCE",
] as const;

const EVIDENCE_KINDS = [
  "SESSION",
  "REFERENCE",
  "APPROVAL",
  "RENDER",
  "GIT",
  "GOVERNANCE",
] as const;

const MAX_MESSAGE_BYTES = 280;
const MAX_EVIDENCE_REFERENCES = 32;
const MAX_EVIDENCE_LABEL_BYTES = 160;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];
export type ActivityEvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface ActivityEvidenceReference {
  readonly kind: ActivityEvidenceKind;
  readonly id: string;
  readonly label?: string;
}

export interface ActivityEvent {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly occurredAt: ISODateTime;
  readonly category: ActivityCategory;
  readonly message: string;
  readonly evidence: readonly ActivityEvidenceReference[];
}

export type ActivityEventInput = Omit<ActivityEvent, "evidence"> & {
  readonly evidence: readonly ActivityEvidenceReference[];
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isCanonicalTimestamp(value: unknown): value is ISODateTime {
  if (typeof value !== "string" || value.length !== 24) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isActivityCategory(value: unknown): value is ActivityCategory {
  return typeof value === "string" && (ACTIVITY_CATEGORIES as readonly string[]).includes(value);
}

function isEvidenceKind(value: unknown): value is ActivityEvidenceKind {
  return typeof value === "string" && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

function isConcreteMessage(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed === value &&
    byteLength(value) <= MAX_MESSAGE_BYTES &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !/thinking/iu.test(value)
  );
}

function isEvidenceReference(value: unknown): value is ActivityEvidenceReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as Partial<ActivityEvidenceReference>;
  const keys = Object.keys(value);
  return (
    keys.length >= 2 &&
    keys.length <= 3 &&
    keys.every((key) => key === "kind" || key === "id" || key === "label") &&
    isEvidenceKind(reference.kind) &&
    isIdentifier(reference.id) &&
    (reference.label === undefined ||
      (typeof reference.label === "string" &&
        reference.label.trim().length > 0 &&
        reference.label === reference.label.trim() &&
        byteLength(reference.label) <= MAX_EVIDENCE_LABEL_BYTES &&
        !/[\u0000-\u001f\u007f]/.test(reference.label)))
  );
}

export function validateActivityEvent(value: unknown): value is ActivityEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<ActivityEvent>;
  const keys = Object.keys(value);
  if (
    keys.length !== 7 ||
    !["id", "projectId", "sessionId", "occurredAt", "category", "message", "evidence"].every(
      (key) => keys.includes(key),
    ) ||
    !isIdentifier(event.id) ||
    !isIdentifier(event.projectId) ||
    !isIdentifier(event.sessionId) ||
    !isCanonicalTimestamp(event.occurredAt) ||
    !isActivityCategory(event.category) ||
    !isConcreteMessage(event.message) ||
    !Array.isArray(event.evidence) ||
    event.evidence.length === 0 ||
    event.evidence.length > MAX_EVIDENCE_REFERENCES ||
    !event.evidence.every(isEvidenceReference)
  ) {
    return false;
  }
  const evidenceIdentity = event.evidence.map(({ kind, id }) => `${kind}:${id}`);
  return new Set(evidenceIdentity).size === evidenceIdentity.length;
}

/**
 * Makes a read-only activity record from an authenticated durable transition.
 * Events carry references only; callers never place filesystem paths, secrets,
 * or unbounded artifact content into the activity stream.
 */
export function createActivityEvent(input: ActivityEventInput): ActivityEvent {
  if (!validateActivityEvent(input as unknown)) {
    if (typeof input.message === "string" && /thinking/iu.test(input.message)) {
      throw new Error("Activity messages must describe a concrete workflow state");
    }
    throw new Error("Activity event is invalid");
  }
  const evidence = Object.freeze(
    input.evidence.map((reference) =>
      Object.freeze({
        kind: reference.kind,
        id: reference.id,
        ...(reference.label === undefined ? {} : { label: reference.label }),
      }),
    ),
  );
  return Object.freeze({
    id: input.id,
    projectId: input.projectId,
    sessionId: input.sessionId,
    occurredAt: input.occurredAt,
    category: input.category,
    message: input.message,
    evidence,
  });
}

/** Newest first, then stable canonical identifiers for total deterministic order. */
export function compareActivityEvents(left: ActivityEvent, right: ActivityEvent): number {
  return (
    right.occurredAt.localeCompare(left.occurredAt) ||
    left.sessionId.localeCompare(right.sessionId) ||
    left.id.localeCompare(right.id) ||
    left.projectId.localeCompare(right.projectId) ||
    left.category.localeCompare(right.category) ||
    left.message.localeCompare(right.message) ||
    JSON.stringify(left.evidence).localeCompare(JSON.stringify(right.evidence))
  );
}

export function orderActivityEvents(
  events: readonly ActivityEvent[],
): readonly ActivityEvent[] {
  const normalized = events.map((event) => createActivityEvent(event));
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw new Error("Activity event identities must be unique");
  }
  return Object.freeze(normalized.sort(compareActivityEvents));
}
