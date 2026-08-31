import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type {
  DriftReport,
  GovernanceEvidenceCatalogEntry,
  ScreenRecord,
} from "@design-sharingan/core";
import {
  DRIFT_REPORT_FILE,
  commitAuditGenerationUnderLock,
  incrementGovernanceRevision,
  readEvidenceCatalog,
  readGenome,
  readGovernanceDocument,
  safeProjectId,
  withGovernanceLock,
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

function unresolvedFindings(
  previous: ReadonlyArray<DriftReport["findings"][number]>,
  next: ReadonlyArray<DriftReport["findings"][number]>,
): DriftReport["findings"] {
  const nextByIdentity = new Map(next.map((finding) => [`${finding.scope}\0${finding.genomeRuleId}`, finding]));
  const retained = previous.filter((finding) => {
    if (finding.status === "INTENTIONAL" || finding.status === "RESOLVED") return false;
    const replacement = nextByIdentity.get(`${finding.scope}\0${finding.genomeRuleId}`);
    return replacement === undefined || (replacement.status !== "INTENTIONAL" && replacement.status !== "RESOLVED");
  });
  const order = [
    "UX_NAVIGATION",
    "ACCESSIBILITY_REQUIRED_STATES",
    "PRODUCT_IDENTITY_SCREEN_FAMILY",
    "COMPONENTS_TOKENS",
    "HIERARCHY",
    "MOTION",
    "POLISH",
  ];
  return [...retained, ...next].sort((left, right) =>
    order.indexOf(left.category) - order.indexOf(right.category) ||
    `${left.scope}\0${left.genomeRuleId}`.localeCompare(`${right.scope}\0${right.genomeRuleId}`),
  );
}

function authenticatedRenderIds(entries: readonly GovernanceEvidenceCatalogEntry[]): Set<string> {
  return new Set(entries.filter((entry) =>
    entry.kind === "RENDER" &&
    entry.authenticatedRenderId !== undefined &&
    entry.renderState !== undefined &&
    entry.renderCapturedAt !== undefined &&
    entry.renderSourceRevisionFingerprint !== undefined,
  ).map(({ id }) => id));
}

function scopeKey(route: string, state: string): string {
  return `${route}#${state}`;
}

function reportScopeMatchesRegistry(report: DriftReport, records: readonly ScreenRecord[]): boolean {
  if (report.expectedScope.length !== records.length) return false;
  const expected = new Map(report.expectedScope.map((entry) => [entry.screen, entry.states]));
  return records.every((record) => {
    const states = expected.get(record.route);
    return states !== undefined && states.length === record.requiredStates.length &&
      states.every((state) => record.requiredStates.includes(state));
  });
}

function validateIntrinsicReportTruth(
  report: DriftReport,
  records: readonly ScreenRecord[],
  catalog: readonly GovernanceEvidenceCatalogEntry[],
  genome: import("@design-sharingan/core").DesignGenome,
): void {
  if (!reportScopeMatchesRegistry(report, records)) {
    throw new Error("Drift Report scope no longer exactly matches the current Screen Registry");
  }
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  const inspected = new Set(report.inspectedScope);
  const unavailable = new Set([...report.unavailableScope, ...report.unverifiedScope]);
  for (const record of records) {
    for (const state of record.requiredStates) {
      const key = scopeKey(record.route, state);
      if (!inspected.has(key)) {
        if (![...unavailable].some((value) => value.startsWith(`${key}:`))) {
          throw new Error("Drift Report must explicitly enumerate unavailable required state evidence");
        }
        continue;
      }
      const matching = report.evidenceIds
        .map((id) => catalogById.get(id))
        .some((entry) => entry?.kind === "RENDER" && entry.route === record.route &&
          entry.renderState === state && entry.authenticatedRenderId !== undefined &&
          entry.renderCapturedAt !== undefined && entry.renderSourceRevisionFingerprint !== undefined);
      if (!matching) {
        throw new Error("Inspected Drift Report scope requires authenticated state-bound render evidence");
      }
    }
  }
  for (const finding of report.findings) {
    const [route] = finding.scope.split("#", 1);
    const validRule = [
      genome.productIdentity,
      ...genome.uxInvariants,
      ...genome.visualInvariants,
      ...genome.motionRules,
      ...genome.accessibilityRules,
      ...genome.componentDNA,
      ...genome.screenFamilies,
    ].includes(finding.expectedRule);
    const expectedRuleId = `genome-rule-${createHash("sha256")
      .update(`${finding.category}\0${finding.expectedRule}`, "utf8")
      .digest("hex")
      .slice(0, 24)}`;
    if (
      !validRule || finding.genomeRuleId !== expectedRuleId || finding.evidenceIds.length === 0 ||
      finding.evidenceIds.some((id) => !report.evidenceIds.includes(id) || catalogById.get(id)?.route !== route)
    ) throw new Error("Drift finding is not bound to authenticated evidence and an approved Genome rule");
  }
  if (report.overallStatus === "PASS" || report.overallStatus === "PASS_WITH_DEBT") {
    throw new Error("Drift Report cannot self-authenticate deterministic analysis or release readiness");
  }
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
    if (verification.status === "PASS") {
      throw new Error("Registry PASS cannot be inferred from absent drift observations");
    }
    if (verification.evidenceIds.length === 0 || verification.evidenceIds.some((id) => !validRenderIds.has(id))) {
      throw new Error("Registry verification requires authenticated current render evidence");
    }
    if (verification.states.some((state) => !verification.evidenceIds.some((id) => {
      const entry = catalog.find((candidate) => candidate.id === id);
      return entry?.route === record.route && entry.renderState === state;
    }))) throw new Error("Registry verification must bind every state to its authenticated render");
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
    metadata.registryRevision !== registry.metadata.revision
  ) throw new Error("Drift Report is not related to the active governance documents");
  const catalogIds = new Set(catalog.map(({ id }) => id));
  if (
    metadata.evidenceIds.some((id) => !catalogIds.has(id)) ||
    metadata.value.evidenceIds.some((id) => !catalogIds.has(id))
  ) throw new Error("Drift Report evidence is not authenticated by the durable evidence catalog");
  validateIntrinsicReportTruth(metadata.value, registry.records, catalog, genome.value);
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
      ...(existingReport?.kind === "DRIFT_REPORT" ? existingReport.value.evidenceIds : []),
      ...input.report.evidenceIds,
      ...input.evidenceCatalog.map(({ id }) => id),
      ...(input.verifiedRegistry ?? []).flatMap(({ evidenceIds }) => evidenceIds),
    ])];
    if (reportEvidenceIds.some((id) => !catalog.some((entry) => entry.id === id))) {
      throw new Error("Drift Report references evidence outside the authenticated catalog");
    }
    const report: DriftReport = {
      ...input.report,
      findings: unresolvedFindings(
        existingReport?.kind === "DRIFT_REPORT" ? existingReport.value.findings : [],
        input.report.findings,
      ),
      evidenceIds: reportEvidenceIds,
    };
    validateIntrinsicReportTruth(report, registry.records, catalog, genome.value);

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
    await commitAuditGenerationUnderLock({
      rootPath: input.rootPath,
      projectId: input.projectId,
      governanceDirectory: directory,
      registryMarkdown: renderScreenRegistry(registryMetadata),
      registryEntityId: registryMetadata.entityId,
      registryRevision: registryMetadata.revision,
      reportMarkdown: renderDriftReport(metadata),
      reportEntityId: metadata.entityId,
      reportRevision: metadata.revision,
      catalog,
    });
    return document(metadata);
  });
}
