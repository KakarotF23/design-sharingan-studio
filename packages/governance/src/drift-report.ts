import { randomUUID } from "node:crypto";
import type {
  DriftReport,
  GovernanceEvidenceCatalogEntry,
  ScreenRecord,
} from "@design-sharingan/core";
import {
  DRIFT_REPORT_FILE,
  atomicWriteDocument,
  incrementGovernanceRevision,
  machineStateDirectory,
  readEvidenceCatalog,
  readGenome,
  readGovernanceDocument,
  safeProjectId,
  withGovernanceLock,
  writeEvidenceCatalogUnderLock,
} from "./genome-store";
import { readScreenRegistry } from "./screen-registry";
import {
  assertScreenRecords,
  renderDriftReport,
  renderScreenRegistry,
  type DriftReportMetadata,
  type ScreenRegistryMetadata,
} from "./templates";

export interface DriftReportDocument {
  metadata: Omit<DriftReportMetadata, "value">;
  value: DriftReport;
}

export interface VerifiedRegistryEntry {
  screen: string;
  states: string[];
  status: Exclude<ScreenRecord["driftStatus"], "NOT_VERIFIED">;
  evidenceIds: string[];
  lastVerified: string;
}

export interface SaveDriftReportInput {
  rootPath: string;
  projectId: string;
  expectedRevision: number;
  evidenceCatalog: GovernanceEvidenceCatalogEntry[];
  report: DriftReport;
  verifiedRegistry?: VerifiedRegistryEntry[];
  auditedAt?: string;
}

function document(metadata: DriftReportMetadata): DriftReportDocument {
  const { value, ...identity } = metadata;
  return { metadata: identity, value };
}

function exactIso(value: string, label: string): string {
  if (new Date(value).toISOString() !== value) throw new Error(`${label} must be an exact ISO timestamp`);
  return value;
}

function mergeCatalog(
  current: readonly GovernanceEvidenceCatalogEntry[],
  incoming: readonly GovernanceEvidenceCatalogEntry[],
): GovernanceEvidenceCatalogEntry[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const previous = merged.get(entry.id);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(entry)) {
      throw new Error("Governance evidence identity cannot be rebound");
    }
    merged.set(entry.id, entry);
  }
  const entries = [...merged.values()];
  if (entries.length > 32) throw new Error("Governance evidence catalog must remain bounded");
  return entries;
}

function authenticatedRenderIds(entries: readonly GovernanceEvidenceCatalogEntry[]): Set<string> {
  return new Set(entries.filter((entry) =>
    entry.kind === "RENDER" &&
    entry.authenticatedRenderId !== undefined &&
    entry.renderCapturedAt !== undefined &&
    entry.renderSourceRevisionFingerprint !== undefined,
  ).map(({ id }) => id));
}

function registryWithVerification(
  records: readonly ScreenRecord[],
  verified: readonly VerifiedRegistryEntry[],
  catalog: readonly GovernanceEvidenceCatalogEntry[],
): ScreenRecord[] {
  const verifiedByRoute = new Map(verified.map((entry) => [entry.screen, entry]));
  if (verifiedByRoute.size !== verified.length) throw new Error("Screen verification cannot duplicate a route");
  const validRenderIds = authenticatedRenderIds(catalog);
  return records.map((record) => {
    const verification = verifiedByRoute.get(record.route);
    if (verification === undefined) return { ...record };
    if (new Set(verification.states).size !== verification.states.length ||
      verification.states.length !== record.requiredStates.length ||
      verification.states.some((state) => !record.requiredStates.includes(state))) {
      throw new Error("Registry verification must cover every required screen state");
    }
    if (verification.evidenceIds.length === 0 || verification.evidenceIds.some((id) => !validRenderIds.has(id))) {
      throw new Error("Registry verification requires authenticated current render evidence");
    }
    exactIso(verification.lastVerified, "Registry verification time");
    return {
      ...record,
      evidence: [...new Set([...record.evidence, ...verification.evidenceIds])],
      driftStatus: verification.status,
      lastVerified: verification.lastVerified,
    };
  });
}

export async function readDriftReport(
  rootPath: string,
  projectId: string,
): Promise<DriftReportDocument> {
  const metadata = await readGovernanceDocument(rootPath, projectId, DRIFT_REPORT_FILE);
  if (metadata.kind !== "DRIFT_REPORT") {
    throw new Error("DRIFT-REPORT.md contains the wrong governance document kind");
  }
  const [genome, registry, catalog] = await Promise.all([
    readGenome(rootPath, projectId),
    readScreenRegistry(rootPath, projectId),
    readEvidenceCatalog(rootPath, projectId),
  ]);
  if (
    metadata.genomeEntityId !== genome.metadata.entityId ||
    metadata.genomeVersion !== genome.value.version ||
    metadata.genomeRevision > genome.metadata.revision ||
    metadata.registryEntityId !== registry.metadata.entityId ||
    metadata.registryRevision > registry.metadata.revision
  ) throw new Error("Drift Report is not related to the active governance documents");
  const catalogIds = new Set(catalog.map(({ id }) => id));
  if (
    metadata.evidenceIds.some((id) => !catalogIds.has(id)) ||
    metadata.value.evidenceIds.some((id) => !catalogIds.has(id))
  ) throw new Error("Drift Report evidence is not authenticated by the durable evidence catalog");
  return document(metadata);
}

export async function saveDriftReport(input: SaveDriftReportInput): Promise<DriftReportDocument> {
  safeProjectId(input.projectId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new Error("Expected Registry revision is invalid");
  }
  const auditedAt = exactIso(input.auditedAt ?? new Date().toISOString(), "Audit time");
  return withGovernanceLock(input.rootPath, async (directory) => {
    const existingReport = await readGovernanceDocument(
      input.rootPath,
      input.projectId,
      DRIFT_REPORT_FILE,
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existingReport !== undefined && existingReport.kind !== "DRIFT_REPORT") {
      throw new Error("DRIFT-REPORT.md contains the wrong governance document kind");
    }
    const [genome, registry, currentCatalog] = await Promise.all([
      readGenome(input.rootPath, input.projectId),
      readScreenRegistry(input.rootPath, input.projectId),
      readEvidenceCatalog(input.rootPath, input.projectId),
    ]);
    if (registry.metadata.revision !== input.expectedRevision) {
      throw new Error("Screen Registry revision is stale");
    }
    const catalog = mergeCatalog(currentCatalog, input.evidenceCatalog);
    const reportEvidenceIds = [...new Set([
      ...input.report.evidenceIds,
      ...input.evidenceCatalog.map(({ id }) => id),
      ...(input.verifiedRegistry ?? []).flatMap(({ evidenceIds }) => evidenceIds),
    ])];
    if (reportEvidenceIds.some((id) => !catalog.some((entry) => entry.id === id))) {
      throw new Error("Drift Report references evidence outside the authenticated catalog");
    }
    const report: DriftReport = { ...input.report, evidenceIds: reportEvidenceIds };

    // The catalog is atomically authenticated under the same governance lock before
    // any Registry status or report can become visible as verified.
    await writeEvidenceCatalogUnderLock(
      input.rootPath,
      input.projectId,
      await machineStateDirectory(input.rootPath, false),
      catalog,
    );

    const records = registryWithVerification(
      registry.records,
      input.verifiedRegistry ?? [],
      catalog,
    );
    const registryMetadata: ScreenRegistryMetadata = {
      ...registry.metadata,
      revision: incrementGovernanceRevision(registry.metadata.revision),
      evidenceIds: [...new Set(records.flatMap(({ evidence }) => evidence))],
      records: assertScreenRecords(records, {
        genome: genome.value,
        evidenceIds: catalog.map(({ id }) => id),
        evidenceRoutes: Object.fromEntries(catalog.map(({ id, route }) => [id, route])),
        authenticatedVerificationEvidenceIds: [...authenticatedRenderIds(catalog)],
      }),
    };
    await atomicWriteDocument(
      directory,
      "SCREEN-REGISTRY.md",
      renderScreenRegistry(registryMetadata),
    );

    const metadata: DriftReportMetadata = {
      schemaVersion: 1,
      kind: "DRIFT_REPORT",
      projectId: input.projectId,
      entityId: existingReport?.entityId ?? randomUUID(),
      revision: existingReport === undefined ? 1 : incrementGovernanceRevision(existingReport.revision),
      genomeEntityId: genome.metadata.entityId,
      genomeVersion: genome.value.version,
      genomeRevision: genome.metadata.revision,
      registryEntityId: registryMetadata.entityId,
      registryRevision: registryMetadata.revision,
      evidenceIds: reportEvidenceIds,
      auditedAt,
      value: report,
    };
    await atomicWriteDocument(directory, DRIFT_REPORT_FILE, renderDriftReport(metadata));
    return document(metadata);
  });
}
