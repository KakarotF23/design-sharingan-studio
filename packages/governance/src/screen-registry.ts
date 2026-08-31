import type { ScreenRecord } from "@design-sharingan/core";
import {
  SCREEN_REGISTRY_FILE,
  atomicWriteDocument,
  readGovernanceDocument,
  safeProjectId,
  withGovernanceLock,
  readGenome,
  readEvidenceCatalog,
  incrementGovernanceRevision,
} from "./genome-store";
import {
  assertScreenRecords,
  renderScreenRegistry,
  type ScreenRegistryMetadata,
} from "./templates";

export interface ScreenRegistryDocument {
  metadata: Omit<ScreenRegistryMetadata, "records">;
  records: ScreenRecord[];
}

function document(metadata: ScreenRegistryMetadata): ScreenRegistryDocument {
  const { records, ...identity } = metadata;
  return { metadata: identity, records };
}

export async function readScreenRegistry(
  rootPath: string,
  projectId: string,
): Promise<ScreenRegistryDocument> {
  const metadata = await readGovernanceDocument(rootPath, projectId, SCREEN_REGISTRY_FILE);
  if (metadata.kind !== "SCREEN_REGISTRY") {
    throw new Error("SCREEN-REGISTRY.md contains the wrong governance document kind");
  }
  const genome = await readGenome(rootPath, projectId);
  const evidenceCatalog = await readEvidenceCatalog(rootPath, projectId);
  const catalogIds = new Set(evidenceCatalog.map(({ id }) => id));
  if (metadata.evidenceIds.some((id) => !catalogIds.has(id))) {
    throw new Error("Screen Registry evidence is not authenticated by the durable evidence catalog");
  }
  if (
    metadata.genomeEntityId !== genome.metadata.entityId ||
    metadata.genomeVersion !== genome.value.version ||
    metadata.genomeRevision > genome.metadata.revision
  ) {
    throw new Error("Screen Registry is not related to the active Design Genome");
  }
  assertScreenRecords(metadata.records, {
    genome: genome.value,
    evidenceIds: evidenceCatalog.map(({ id }) => id),
    evidenceRoutes: Object.fromEntries(evidenceCatalog.map(({ id, route }) => [id, route])),
  });
  return document(metadata);
}

export async function saveScreenRegistry(
  rootPath: string,
  projectId: string,
  recordsInput: ScreenRecord[],
  expectedRevision: number,
): Promise<ScreenRegistryDocument> {
  safeProjectId(projectId);
  return withGovernanceLock(rootPath, async (directory) => {
    const current = await readScreenRegistry(rootPath, projectId);
    if (current.metadata.revision !== expectedRevision) {
      throw new Error("Screen Registry revision is stale");
    }
    const genome = await readGenome(rootPath, projectId);
    const evidenceCatalog = await readEvidenceCatalog(rootPath, projectId);
    const evidenceIds = [...new Set(recordsInput.flatMap((record) => record.evidence))];
    const records = assertScreenRecords(recordsInput, {
      genome: genome.value,
      evidenceIds: evidenceCatalog.map(({ id }) => id),
      evidenceRoutes: Object.fromEntries(evidenceCatalog.map(({ id, route }) => [id, route])),
    });
    const metadata: ScreenRegistryMetadata = {
      ...current.metadata,
      revision: incrementGovernanceRevision(current.metadata.revision),
      genomeEntityId: genome.metadata.entityId,
      genomeVersion: genome.value.version,
      genomeRevision: genome.metadata.revision,
      evidenceIds,
      records,
    };
    await atomicWriteDocument(directory, SCREEN_REGISTRY_FILE, renderScreenRegistry(metadata));
    return document(metadata);
  });
}
