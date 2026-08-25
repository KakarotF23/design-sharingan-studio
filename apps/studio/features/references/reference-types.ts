import type {
  DesignDNA,
  DesignSession,
  Reference,
} from "@design-sharingan/core";

export type ReferenceView = Omit<Reference, "imagePath">;

export interface ReferenceScanSession extends DesignSession {
  type: "REFERENCE_SCAN";
  referenceId: string;
  referenceTitle: string;
  designDNA: DesignDNA;
  agentThreadId: string;
}

export function referenceView(reference: Reference): ReferenceView {
  const { imagePath: _privateImagePath, ...view } = reference;
  return view;
}
