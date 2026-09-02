import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignGenome, DesignSession, Project, ScreenRecord } from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProjectReport,
  saveProjectMetadata,
  saveSession,
} from "@design-sharingan/project-adapters";
import {
  approveGenome,
  governanceRootFingerprint,
  initializeGovernance,
  parseGovernanceMetadata,
  readGenome,
  renderGenome,
} from "../index";
import { authenticateGovernanceReportSession } from "../../../../apps/studio/features/govern/govern-server";

const roots: string[] = [];

interface GovernanceSessionCheckpoint {
  type: "GENOME_INIT";
  status: string;
  entityId: string;
  revision: number;
  artifactFingerprint: string;
  rootFingerprint: string;
}

function canonicalJson(value: unknown): string {
  function sort(entry: unknown): unknown {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, sort(nested)]),
      );
    }
    return entry;
  }

  const serialized = JSON.stringify(sort(value));
  if (serialized === undefined) throw new Error("Governance test fixture is not serializable");
  return serialized;
}

function governanceArtifactFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function governanceSessionId(
  projectId: string,
  checkpoint: GovernanceSessionCheckpoint,
): string {
  return `gov_${createHash("sha256").update(canonicalJson({
    type: checkpoint.type,
    projectId,
    rootFingerprint: checkpoint.rootFingerprint,
    entityId: checkpoint.entityId,
    revision: checkpoint.revision,
    artifactFingerprint: checkpoint.artifactFingerprint,
  }), "utf8").digest("hex")}`;
}

function draftGenome(): DesignGenome {
  return {
    version: "0.1.0",
    status: "DRAFT",
    productIdentity: "A calm local-first design intelligence environment.",
    uxInvariants: ["Keep human decisions explicit."],
    visualInvariants: ["Use one restrained accent."],
    motionRules: ["Reserve motion for state transitions."],
    accessibilityRules: ["Maintain visible focus."],
    componentDNA: ["Use fine rules to separate dense evidence."],
    screenFamilies: ["Project workspaces"],
    contentVoice: ["Calm, technical, and direct."],
    intentionalExceptions: ["Overview may use a wider orientation block."],
    unconfirmedRules: ["Compact density may be preferred on evidence screens."],
  };
}

function screenRecord(): ScreenRecord {
  return {
    id: "screen-overview",
    route: "/overview",
    name: "Overview",
    family: "Project workspaces",
    inheritedRules: ["Keep human decisions explicit."],
    exceptions: ["Overview may use a wider orientation block."],
    requiredStates: ["default"],
    evidence: ["ev_route_overview_01"],
    driftStatus: "NOT_VERIFIED",
  };
}

function evidenceCatalog() {
  return [{
    id: "ev_route_overview_01",
    kind: "ROUTE" as const,
    route: "/overview",
    excerpt: "Authenticated project inspection detected this current route.",
    verifiedClaims: [],
  }];
}

async function projectFixture(): Promise<Project> {
  const rootPath = await realpath(
    await mkdtemp(join(tmpdir(), "design-sharingan-governance-report-")),
  );
  roots.push(rootPath);
  const project: Project = {
    id: "project-report",
    name: "Governance report fixture",
    sourceType: "LOCAL",
    rootPath,
    status: "READY",
    createdAt: "2026-08-31T09:00:00.000Z",
    updatedAt: "2026-08-31T09:00:00.000Z",
  };
  await saveProjectMetadata(project);
  return project;
}

async function approvedGenomeSession(project: Project) {
  const created = await initializeGovernance({
    rootPath: project.rootPath,
    projectId: project.id,
    genome: draftGenome(),
    screens: [screenRecord()],
    evidenceCatalog: evidenceCatalog(),
    decisions: [],
  });
  const genome = await approveGenome(project.rootPath, project.id, {
    approvedBy: "local-user",
    expectedRevision: 1,
    expectedPayloadHash: created.genome.payloadHash,
  });
  const checkpoint: GovernanceSessionCheckpoint = {
    type: "GENOME_INIT",
    status: genome.value.status,
    entityId: genome.metadata.entityId,
    revision: genome.metadata.revision,
    artifactFingerprint: governanceArtifactFingerprint({
      metadata: genome.metadata,
      value: genome.value,
      payloadHash: genome.payloadHash,
      authority: genome.authority,
    }),
    rootFingerprint: await governanceRootFingerprint(project.rootPath),
  };

  return {
    id: governanceSessionId(project.id, checkpoint),
    projectId: project.id,
    type: "GENOME_INIT" as const,
    status: checkpoint.status,
    createdAt: "2026-08-31T09:05:00.000Z",
    updatedAt: "2026-08-31T09:05:00.000Z",
    entityId: checkpoint.entityId,
    revision: checkpoint.revision,
    artifactFingerprint: checkpoint.artifactFingerprint,
    rootFingerprint: checkpoint.rootFingerprint,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("governance report session authentication", () => {
  it("projects only a governance session that still matches the current signed Genome truth", async () => {
    const project = await projectFixture();
    const session = await approvedGenomeSession(project);
    await saveSession(project.rootPath, session);

    const options = {
      authenticateGovernanceSession: async (_rootPath: string, _projectId: string, retained: DesignSession) =>
        authenticateGovernanceReportSession(project, retained),
    };

    await expect(
      loadProjectReport(project.rootPath, project.id, { offset: 0, limit: 25 }, options),
    ).resolves.toMatchObject({
      sessions: [expect.objectContaining({
        id: session.id,
        type: "GENOME_INIT",
        result: "APPROVED",
      })],
    });

    const path = join(project.rootPath, "design-governance", "DESIGN-GENOME.md");
    const metadata = parseGovernanceMetadata(await readFile(path, "utf8"));
    if (metadata.kind !== "DESIGN_GENOME" || metadata.authority === undefined) {
      throw new Error("test fixture lacks authoritative Genome metadata");
    }
    const forged = structuredClone(metadata);
    if (forged.authority === undefined) {
      throw new Error("test fixture lost authoritative Genome proof");
    }
    forged.authority.approvedAt = "yesterday";
    await writeFile(path, renderGenome(forged), "utf8");

    await expect(
      loadProjectReport(project.rootPath, project.id, { offset: 0, limit: 25 }, options),
    ).rejects.toThrow(/authenticated|authority|truth|checkpoint|genome/i);
    await expect(readGenome(project.rootPath, project.id)).rejects.toThrow(
      /authenticated|authority/i,
    );
  });
});
