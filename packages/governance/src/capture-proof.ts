import type { DriftReport, GovernanceEvidenceCatalogEntry } from "@design-sharingan/core";
import { loadGovernanceCaptureSession, type GovernanceCaptureSession } from "@design-sharingan/project-adapters";
import type { GenomeDocument } from "./genome-store";
import { isDeepStrictEqual } from "node:util";

export function captureFullyVerified(proof: Pick<GovernanceCaptureSession, "verifiedCategories" | "analysis" | "browserChecks">): boolean {
  return proof.verifiedCategories.length === 7 && !proof.analysis.findings.some((finding) => finding.severity === "CRITICAL" || finding.severity === "IMPORTANT") && Object.values(proof.analysis.verification).every((check) => check.status === "PASS") && [proof.browserChecks.navigation, proof.browserChecks.accessibility, proof.browserChecks.functionalVerification].every((status) => status === "PASS");
}
export async function authenticateCaptureProofs(root: string, projectId: string, report: DriftReport, genome: GenomeDocument, catalog: readonly GovernanceEvidenceCatalogEntry[]): Promise<GovernanceCaptureSession[]> {
  const ids = report.verificationSessionIds ?? [];
  if (ids.length > 16 || new Set(ids).size !== ids.length) throw new Error("Capture proof identities are ambiguous or unbounded");
  const expectedGenome = { entityId: genome.metadata.entityId, version: genome.value.version, revision: genome.metadata.revision, payloadHash: genome.payloadHash };
  const proofs = await Promise.all(ids.map((id) => loadGovernanceCaptureSession(root, projectId, id)));
  for (const proof of proofs) {
    if (!isDeepStrictEqual(proof.genomeEvidence, expectedGenome) || !report.expectedScope.some((scope) => scope.screen === proof.render.route && scope.states.includes(proof.state)) || !catalog.some((entry) => report.evidenceIds.includes(entry.id) && entry.kind === "RENDER" && entry.route === proof.render.route && entry.renderState === proof.state && entry.authenticatedRenderId === proof.render.id && entry.renderCapturedAt === proof.render.capturedAt && proof.render.sourceRevision.available && entry.renderSourceRevisionFingerprint === proof.render.sourceRevision.worktreeFingerprint)) throw new Error("Capture proof is not bound to this report, render, state and approved Genome");
  }
  return proofs;
}
