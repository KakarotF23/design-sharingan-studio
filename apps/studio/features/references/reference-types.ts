import type {
  DesignDNA,
  DesignSession,
  Reference,
} from "@design-sharingan/core";

export type ReferenceView = Omit<Reference, "imagePath">;

interface ReferenceScanSessionBase extends DesignSession {
  type: "REFERENCE_SCAN";
  referenceId: string;
  referenceTitle: string;
}

export interface ReferenceScanPendingSession extends ReferenceScanSessionBase {
  status: "DRAFT" | "ANALYZING";
  error?: string;
}

export interface ReferenceScanResultSession extends ReferenceScanSessionBase {
  status: "RESULT_READY";
  designDNA: DesignDNA;
  agentThreadId: string;
}

export type ReferenceScanSession =
  | ReferenceScanPendingSession
  | ReferenceScanResultSession;

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isDesignDNA(value: unknown): value is DesignDNA {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const designDNA = value as Partial<DesignDNA>;
  return (
    typeof designDNA.id === "string" &&
    [
      designDNA.referenceIds,
      designDNA.hierarchy,
      designDNA.layout,
      designDNA.spacing,
      designDNA.typography,
      designDNA.colorLogic,
      designDNA.componentGeometry,
      designDNA.navigation,
      designDNA.interaction,
      designDNA.motion,
      designDNA.density,
      designDNA.emotionalTone,
      designDNA.visualWeight,
      designDNA.keep,
      designDNA.reject,
      designDNA.adapt,
      designDNA.invent,
    ].every(stringArray)
  );
}

export function isReferenceScanSession(
  value: unknown,
): value is ReferenceScanSession {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const session = value as Partial<ReferenceScanSession> &
    Record<string, unknown>;
  const baseIsValid =
    session.type === "REFERENCE_SCAN" &&
    typeof session.id === "string" &&
    typeof session.projectId === "string" &&
    typeof session.referenceId === "string" &&
    typeof session.referenceTitle === "string" &&
    typeof session.createdAt === "string" &&
    typeof session.updatedAt === "string";
  if (!baseIsValid) return false;
  if (session.status === "DRAFT" || session.status === "ANALYZING") {
    return session.error === undefined || typeof session.error === "string";
  }
  return (
    session.status === "RESULT_READY" &&
    typeof session.agentThreadId === "string" &&
    isDesignDNA(session.designDNA)
  );
}

export function referenceView(reference: Reference): ReferenceView {
  const { imagePath: _privateImagePath, ...view } = reference;
  return view;
}
