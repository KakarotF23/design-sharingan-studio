import type { ScreenRecord } from "@design-sharingan/core";
import {
  SCREEN_REGISTRY_FILE,
  atomicWriteDocument,
  readGovernanceDocument,
  safeProjectId,
  withGovernanceLock,
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
  return document(metadata);
}

export async function saveScreenRegistry(
  rootPath: string,
  projectId: string,
  recordsInput: ScreenRecord[],
  expectedRevision: number,
): Promise<ScreenRegistryDocument> {
  safeProjectId(projectId);
  const records = assertScreenRecords(recordsInput);
  return withGovernanceLock(rootPath, async (directory) => {
    const current = await readScreenRegistry(rootPath, projectId);
    if (current.metadata.revision !== expectedRevision) {
      throw new Error("Screen Registry revision is stale");
    }
    const metadata: ScreenRegistryMetadata = {
      ...current.metadata,
      revision: current.metadata.revision + 1,
      records,
    };
    await atomicWriteDocument(directory, SCREEN_REGISTRY_FILE, renderScreenRegistry(metadata));
    return document(metadata);
  });
}
