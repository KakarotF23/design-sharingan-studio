import { createHash, randomUUID } from "node:crypto";
import type { FeatureBrief, GovernanceFindingSource, Project } from "@design-sharingan/core";
import { readDriftReport, readDesignDecisions, recordApprovedNonConsequentialDecision } from "@design-sharingan/governance";
import type { DesignDecision, DriftFinding } from "@design-sharingan/core";

/** Inputs are read from authenticated governance documents by the caller. Partial debt never masks other work. */
export function deriveDocumentedPolishDebt(findings: readonly Pick<DriftFinding, "scope" | "expectedRule" | "severity" | "status" | "requiresDesignDecision" | "evidenceIds">[], decisions: readonly Pick<DesignDecision, "id" | "status" | "approvedBy" | "decision" | "reason" | "migrationRequired" | "genomeChanges">[]) {
  const unresolved = findings.filter((finding) => !["RESOLVED", "INTENTIONAL"].includes(finding.status));
  if (unresolved.some((finding) => finding.severity !== "POLISH" || finding.requiresDesignDecision)) return [];
  const debt = unresolved.flatMap((finding) => {
    const decision = decisions.find((entry) => entry.status === "APPROVED" && entry.approvedBy === "local-user" && !entry.migrationRequired && entry.genomeChanges.length === 0 && entry.decision === `Accept polish debt: ${finding.scope}: ${finding.expectedRule}`);
    return decision ? [{ finding: `${finding.scope}: ${finding.expectedRule}`, rationale: decision.reason, documentedBy: decision.id, evidenceIds: finding.evidenceIds }] : [];
  });
  return debt.length === unresolved.length ? debt : [];
}
export async function resolveGovernanceFinding(project: Project, key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Finding identity is invalid");
  const report = await readDriftReport(project.rootPath, project.id);
  const matching = report.value.findings.filter((finding) => createHash("sha256").update(`${finding.scope}\0${finding.genomeRuleId}`).digest("hex") === key && finding.status !== "RESOLVED" && finding.status !== "INTENTIONAL");
  if (matching.length !== 1) throw new Error("Finding is unavailable, resolved or ambiguous");
  const finding = matching[0]!;
  const sourceFinding: GovernanceFindingSource = { reportEntityId: report.metadata.entityId, reportRevision: report.metadata.revision, findingKey: key, scope: finding.scope, evidenceIds: [...finding.evidenceIds] };
  const featureBrief: FeatureBrief = { name: `Resolve ${finding.category.toLowerCase().replaceAll("_", " ")} drift`.slice(0, 160), goal: finding.recommendedFix, description: `${finding.scope}: ${finding.expectedRule}\nObserved: ${finding.observedEvidence.join(" ")}\nWhy: ${finding.whyItMatters}`.slice(0, 4000), constraints: ["Use the authenticated finding as evidence, never as permission to change product rules."], mustKeep: [finding.expectedRule], mustNotChange: ["Preserve navigation, persistent data models, dependencies and protected paths."], successCriteria: ["A fresh render rechecks this finding after the approved change."] };
  return { finding, sourceFinding, featureBrief };
}
export async function recordProjectPolishDebt(project: Project, findingKey: string, rationale: string): Promise<void> {
  if (!rationale.trim() || rationale.length > 2000) throw new Error("A bounded rationale is required");
  const { finding } = await resolveGovernanceFinding(project, findingKey);
  if (finding.severity !== "POLISH" || finding.requiresDesignDecision) throw new Error("Only non-blocking polish can be documented as release debt");
  const decisions = await readDesignDecisions(project.rootPath, project.id);
  const decision = `Accept polish debt: ${finding.scope}: ${finding.expectedRule}`;
  if (decisions.decisions.some((entry) => entry.status === "APPROVED" && entry.decision === decision)) throw new Error("This polish debt is already documented");
  await recordApprovedNonConsequentialDecision(project.rootPath, project.id, { id: `debt-${randomUUID()}`, date: new Date().toISOString(), status: "APPROVED", approvedBy: "local-user", scope: finding.scope, decision, reason: rationale.trim(), alternatives: ["Fix before release", "Accept tracked non-blocking polish debt"], affectedScreens: [finding.scope.slice(0, finding.scope.lastIndexOf("#"))], affectedComponents: [], migrationRequired: false, genomeChanges: [] }, decisions.metadata.revision);
}
