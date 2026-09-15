import type { DesignSession, DriftAuditCategory, GenomeEvidence, RenderArtifact } from "@design-sharingan/core";
import { isDesignSessionEnvelope, isGenomeEvidence, isCanonicalIsoDateTime } from "@design-sharingan/core";
import { assertRenderArtifactIntegrity, loadSession, saveSession } from "./workspace-store";
import { isSafeRenderVerification, type SafeRenderVerification } from "./safe-execution-store";
export interface BrowserVerificationChecks {
  navigation: "PASS" | "FAIL" | "NOT_VERIFIED";
  accessibility: "PASS" | "FAIL" | "NOT_VERIFIED";
  functionalVerification: "PASS" | "FAIL" | "NOT_VERIFIED";
  evidence: string[];
}
export interface GovernanceCaptureSession extends DesignSession {
  type: "GOVERNANCE_CAPTURE";
  status: "COMPLETE";
  state: string;
  render: RenderArtifact;
  genomeEvidence: GenomeEvidence;
  browserChecks: BrowserVerificationChecks;
  analysis: SafeRenderVerification;
  verifiedCategories: { category: DriftAuditCategory; evidence: string[] }[];
}
const categories = ["UX_NAVIGATION", "ACCESSIBILITY_REQUIRED_STATES", "PRODUCT_IDENTITY_SCREEN_FAMILY", "COMPONENTS_TOKENS", "HIERARCHY", "MOTION", "POLISH"];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const details = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every((entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 2000);
export function isGovernanceCaptureSession(value: unknown): value is GovernanceCaptureSession {
  if (!isDesignSessionEnvelope(value) || !object(value) || value.type !== "GOVERNANCE_CAPTURE" || value.status !== "COMPLETE" || Object.keys(value).sort().join() !== ["id", "projectId", "type", "status", "createdAt", "updatedAt", "state", "render", "genomeEvidence", "browserChecks", "analysis", "verifiedCategories"].sort().join() || !isGenomeEvidence(value.genomeEvidence) || !object(value.render) || value.render.sessionId !== value.id || !isCanonicalIsoDateTime(value.render.capturedAt) || value.render.capturedAt < value.createdAt || value.render.capturedAt > value.updatedAt || typeof value.state !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.state) || !isSafeRenderVerification(value.analysis, value.render.route as string)) return false;
  const checks = value.browserChecks;
  return object(checks) && Object.keys(checks).sort().join() === ["navigation", "accessibility", "functionalVerification", "evidence"].sort().join() && [checks.navigation, checks.accessibility, checks.functionalVerification].every((status) => ["PASS", "FAIL", "NOT_VERIFIED"].includes(status as string)) && details(checks.evidence) && Array.isArray(value.verifiedCategories) && value.verifiedCategories.length <= categories.length && new Set(value.verifiedCategories.map((entry) => entry.category)).size === value.verifiedCategories.length && value.verifiedCategories.every((entry) => object(entry) && Object.keys(entry).sort().join() === "category,evidence" && categories.includes(entry.category as string) && details(entry.evidence));
}
export async function saveGovernanceCaptureSession(root: string, session: GovernanceCaptureSession) {
  if (!isGovernanceCaptureSession(session)) throw new Error("Governance capture evidence is invalid");
  await assertRenderArtifactIntegrity(root, session.render);
  await saveSession(root, session);
}
export async function loadGovernanceCaptureSession(root: string, projectId: string, id: string): Promise<GovernanceCaptureSession> {
  const session = await loadSession(root, projectId, id);
  if (!isGovernanceCaptureSession(session)) throw new Error("Governance capture evidence is invalid");
  await assertRenderArtifactIntegrity(root, session.render);
  return session;
}
