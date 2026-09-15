import type { DesignDecision } from "@design-sharingan/core";
import {
  DESIGN_DECISIONS_FILE,
  atomicWriteDocument,
  readGovernanceDocument,
  safeProjectId,
  withGovernanceLock,
  readGenome,
  assertAuthenticatedDecisionProofs,
  incrementGovernanceRevision,
} from "./genome-store";
import {
  assertDesignDecisions,
  renderDesignDecisions,
  type DesignDecisionsMetadata,
} from "./templates";
import { readScreenRegistry } from "./screen-registry";

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
  const genome = await readGenome(rootPath, projectId);
  if (
    metadata.genomeEntityId !== genome.metadata.entityId ||
    metadata.genomeVersion !== genome.value.version ||
    metadata.genomeRevision > genome.metadata.revision
  ) {
    throw new Error("Design Decisions are not related to the active Design Genome");
  }
  const registry = await readScreenRegistry(rootPath, projectId);
  assertDesignDecisions(metadata.decisions, metadata.approvalProofs, registry.records);
  await assertAuthenticatedDecisionProofs(rootPath, metadata);
  return document(metadata);
}

export async function saveDesignDecisions(
  rootPath: string,
  projectId: string,
  decisionsInput: DesignDecision[],
  expectedRevision: number,
): Promise<DesignDecisionsDocument> {
  safeProjectId(projectId);
  return withGovernanceLock(rootPath, async (directory) => {
    const current = await readDesignDecisions(rootPath, projectId);
    if (current.metadata.revision !== expectedRevision) {
      throw new Error("Design Decisions revision is stale");
    }
    const genome = await readGenome(rootPath, projectId);
    const registry = await readScreenRegistry(rootPath, projectId);
    const decisions = assertDesignDecisions(
      decisionsInput,
      current.metadata.approvalProofs,
      registry.records,
    );
    const metadata: DesignDecisionsMetadata = {
      ...current.metadata,
      revision: incrementGovernanceRevision(current.metadata.revision),
      genomeEntityId: genome.metadata.entityId,
      genomeVersion: genome.value.version,
      genomeRevision: genome.metadata.revision,
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
