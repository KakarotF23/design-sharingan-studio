import { rm } from "node:fs/promises";
import type { Project } from "@design-sharingan/core";
import { initializeGenomeWithCodex } from "@design-sharingan/eternal-engine";
import {
  approveGenome,
  governanceIsInitialized,
  initializeGovernance,
  readGenome,
  readScreenRegistry,
} from "@design-sharingan/governance";
import {
  collectGovernanceEvidence,
  detectProject,
} from "@design-sharingan/project-adapters";
import { createAnalysisStagingDirectory } from "../projects/project-locator";

export interface GovernGenomeProjection {
  status: "DRAFT" | "APPROVED";
  authority: "NON-AUTHORITATIVE" | "AUTHORITATIVE";
  revision: number;
  version: string;
  payloadHash: string;
  productIdentity: string;
  uxInvariants: string[];
  visualInvariants: string[];
  motionRules: string[];
  accessibilityRules: string[];
  componentDNA: string[];
  screenFamilies: string[];
  contentVoice: string[];
  intentionalExceptions: string[];
  unconfirmedRules: string[];
}

export interface GovernScreenProjection {
  id: string;
  route: string;
  name: string;
  family: string;
  inheritedRules: string[];
  exceptions: string[];
  requiredStates: string[];
  evidence: string[];
  driftStatus: string;
  lastVerified?: string;
}

export type GovernanceProjection =
  | { initialized: false }
  | {
      initialized: true;
      genome: GovernGenomeProjection;
      screens: GovernScreenProjection[];
    };

export async function loadGovernanceProjection(
  project: Project,
): Promise<GovernanceProjection> {
  if (!(await governanceIsInitialized(project.rootPath))) {
    return { initialized: false };
  }
  const [genome, registry] = await Promise.all([
    readGenome(project.rootPath, project.id),
    readScreenRegistry(project.rootPath, project.id),
  ]);
  return {
    initialized: true,
    genome: {
      status: genome.value.status,
      authority: genome.authority === "AUTHORITATIVE" ? "AUTHORITATIVE" : "NON-AUTHORITATIVE",
      revision: genome.metadata.revision,
      version: genome.value.version,
      payloadHash: genome.payloadHash,
      productIdentity: genome.value.productIdentity,
      uxInvariants: genome.value.uxInvariants,
      visualInvariants: genome.value.visualInvariants,
      motionRules: genome.value.motionRules,
      accessibilityRules: genome.value.accessibilityRules,
      componentDNA: genome.value.componentDNA,
      screenFamilies: genome.value.screenFamilies,
      contentVoice: genome.value.contentVoice,
      intentionalExceptions: genome.value.intentionalExceptions,
      unconfirmedRules: genome.value.unconfirmedRules,
    },
    screens: registry.records.map((screen) => ({ ...screen })),
  };
}

export async function initializeProjectGovernance(
  project: Project,
): Promise<GovernanceProjection> {
  if (await governanceIsInitialized(project.rootPath)) {
    throw new Error("Governance is already initialized");
  }
  const detection = await detectProject(project.rootPath);
  if (!detection.capabilities.canReadFiles || !detection.capabilities.canWriteFiles) {
    throw new Error("Project capabilities do not allow governance initialization");
  }
  const representativeRoutes = (
    detection.routes.length > 0
      ? detection.routes.slice(0, 3)
      : [detection.renderTarget ?? "/"]
  );
  const routes = [...new Set([...detection.routes, ...representativeRoutes])];
  const analysisWorkingDirectory = await createAnalysisStagingDirectory(
    project.rootPath,
  );
  const evidenceCatalog = await collectGovernanceEvidence({
    rootPath: project.rootPath,
    projectId: project.id,
    routes: representativeRoutes,
    componentDirectories: detection.componentDirectories,
    designDocuments: detection.designDocuments,
  });
  let result: Awaited<ReturnType<typeof initializeGenomeWithCodex>>;
  try {
    result = await initializeGenomeWithCodex(
      {
        workingDirectory: analysisWorkingDirectory,
        projectContext: {
          projectId: project.id,
          name: project.name,
          framework: detection.framework,
          routes,
          componentDirectories: [...detection.componentDirectories],
          designDocuments: [...detection.designDocuments],
        },
        representativeEvidence: representativeRoutes.map((route) => ({
          route,
          observations: [
            "Authenticated project inspection detected this current route or render target.",
            "Evidence is representative only and does not establish whole-product coverage.",
          ],
          evidence: evidenceCatalog
            .filter((evidence) => evidence.route === route)
            .map(({ id, kind, excerpt }) => ({ id, kind, excerpt })),
        })),
      },
    );
  } finally {
    await rm(/* turbopackIgnore: true */ analysisWorkingDirectory, {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
  await initializeGovernance({
    rootPath: project.rootPath,
    projectId: project.id,
    genome: result.genome,
    screens: result.screens,
    decisions: [],
  });
  return loadGovernanceProjection(project);
}

export async function approveProjectGenome(
  project: Project,
  expectedRevision: number,
  expectedPayloadHash: string,
): Promise<GovernanceProjection> {
  await approveGenome(project.rootPath, project.id, {
    approvedBy: "local-user",
    expectedRevision,
    expectedPayloadHash,
  });
  return loadGovernanceProjection(project);
}
