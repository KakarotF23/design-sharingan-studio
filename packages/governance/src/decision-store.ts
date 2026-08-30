import type { DesignDecision } from "@design-sharingan/core";
import {
  DESIGN_DECISIONS_FILE,
  atomicWriteDocument,
  readGovernanceDocument,
  safeProjectId,
  withGovernanceLock,
} from "./genome-store";
import {
  assertDesignDecisions,
  renderDesignDecisions,
  type DesignDecisionsMetadata,
} from "./templates";

export interface DesignDecisionsDocument {
  metadata: Omit<DesignDecisionsMetadata, "decisions">;
  decisions: DesignDecision[];
}

function document(metadata: DesignDecisionsMetadata): DesignDecisionsDocument {
  const { decisions, ...identity } = metadata;
  return { metadata: identity, decisions };
}

export async function readDesignDecisions(
  rootPath: string,
  projectId: string,
): Promise<DesignDecisionsDocument> {
  const metadata = await readGovernanceDocument(rootPath, projectId, DESIGN_DECISIONS_FILE);
  if (metadata.kind !== "DESIGN_DECISIONS") {
    throw new Error("DESIGN-DECISIONS.md contains the wrong governance document kind");
  }
  return document(metadata);
}

export async function saveDesignDecisions(
  rootPath: string,
  projectId: string,
  decisionsInput: DesignDecision[],
  expectedRevision: number,
): Promise<DesignDecisionsDocument> {
  safeProjectId(projectId);
  const decisions = assertDesignDecisions(decisionsInput);
  return withGovernanceLock(rootPath, async (directory) => {
    const current = await readDesignDecisions(rootPath, projectId);
    if (current.metadata.revision !== expectedRevision) {
      throw new Error("Design Decisions revision is stale");
    }
    const metadata: DesignDecisionsMetadata = {
      ...current.metadata,
      revision: current.metadata.revision + 1,
      decisions,
    };
    await atomicWriteDocument(
      directory,
      DESIGN_DECISIONS_FILE,
      renderDesignDecisions(metadata),
    );
    return document(metadata);
  });
}
