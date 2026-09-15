import type { Project } from "@design-sharingan/core";
import { initializeProjectGovernance as initialize } from "@design-sharingan/eternal-engine";
import { createAnalysisStagingDirectory } from "../projects/project-locator";
export { authenticateGovernanceReportSession, canPromoteApprovedClaimToRender, loadGovernanceProjection, approveProjectGenome, auditProjectDrift, evaluateProjectRelease } from "@design-sharingan/eternal-engine";
export type { GovernanceProjection, GovernGenomeProjection, GovernGenomeClaimProjection, GovernReleaseProjection, GovernScreenProjection } from "@design-sharingan/eternal-engine";
export function initializeProjectGovernance(project: Project) {
  return initialize(project, { createAnalysisStagingDirectory });
}
