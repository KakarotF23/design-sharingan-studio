import type { DesignDNA, DesignSession } from "@design-sharingan/core";
import { isDesignSessionEnvelope } from "@design-sharingan/core";
import { listSessions, loadReferenceDesignDNA, saveSession, transitionLearnSession } from "./workspace-store";

interface Base extends DesignSession { type: "ASSIMILATION" | "DESIGN_VERIFY"; referenceIds: string[]; intendedDirection?: string; currentDirection?: string }
export type ReadonlyLearnSession = Base & ({ status: "DRAFT" | "ANALYZING"; error?: string } | { status: "RESULT_READY"; agentThreadId: string; result: { summary: string; sourceMap: { referenceIds: string[]; role: string; principles: string[] }[]; proposedDirection: DesignDNA } | { summary: string; findings: { severity: "CRITICAL" | "IMPORTANT" | "POLISH" | "IGNORE"; principle: string; observation: string; recommendation: string }[]; evidenceScope: "DESIGN_DIRECTION_ONLY" } });
const text = (value: unknown, limit = 8_000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, minimum = 0): value is string[] => Array.isArray(value) && value.length >= minimum && value.length <= 32 && value.every((entry) => text(entry));
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
export function isReadonlyLearnSession(value: unknown): value is ReadonlyLearnSession {
  if (!isDesignSessionEnvelope(value) || !object(value) || !["ASSIMILATION", "DESIGN_VERIFY"].includes(value.type as string) || !only(value, ["id", "projectId", "type", "status", "createdAt", "updatedAt", "referenceIds", "intendedDirection", "currentDirection", "error", "result", "agentThreadId"]) || !strings(value.referenceIds) || new Set(value.referenceIds).size !== value.referenceIds.length) return false;
  if (value.type === "ASSIMILATION" && (value.referenceIds.length < 2 || value.intendedDirection !== undefined || value.currentDirection !== undefined)) return false;
  if (value.type === "DESIGN_VERIFY" && (!text(value.intendedDirection) || !text(value.currentDirection))) return false;
  if (value.status === "DRAFT" || value.status === "ANALYZING") return value.result === undefined && value.agentThreadId === undefined && (value.error === undefined || text(value.error));
  if (value.status !== "RESULT_READY" || value.error !== undefined || !text(value.agentThreadId) || !object(value.result) || !text(value.result.summary)) return false;
  const result = value.result;
  if (value.type === "DESIGN_VERIFY") return only(result, ["summary", "findings", "evidenceScope"]) && result.evidenceScope === "DESIGN_DIRECTION_ONLY" && Array.isArray(result.findings) && result.findings.length <= 32 && result.findings.every((finding) => object(finding) && only(finding, ["severity", "principle", "observation", "recommendation"]) && ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"].includes(finding.severity as string) && text(finding.principle) && text(finding.observation) && text(finding.recommendation));
  if (!only(result, ["summary", "sourceMap", "proposedDirection"]) || !Array.isArray(result.sourceMap) || result.sourceMap.length < 2 || result.sourceMap.length > 16 || !result.sourceMap.every((source) => object(source) && only(source, ["referenceIds", "role", "principles"]) && strings(source.referenceIds, 1) && text(source.role) && strings(source.principles, 1)) || !object(result.proposedDirection)) return false;
  const dna = result.proposedDirection;
  const keys = ["referenceIds", "hierarchy", "layout", "spacing", "typography", "colorLogic", "componentGeometry", "navigation", "interaction", "motion", "density", "emotionalTone", "visualWeight", "keep", "reject", "adapt", "invent"];
  const matches = (ids: string[]) => JSON.stringify([...new Set(ids)].sort()) === JSON.stringify([...value.referenceIds as string[]].sort());
  return only(dna, ["id", ...keys]) && text(dna.id, 128) && keys.every((key) => strings(dna[key], 1)) && matches(dna.referenceIds as string[]) && matches(result.sourceMap.flatMap((source) => source.referenceIds));
}
export async function saveReadonlyLearnSession(rootPath: string, session: ReadonlyLearnSession, expectedStatus?: "DRAFT" | "ANALYZING") {
  if (!isReadonlyLearnSession(session)) throw new Error("Readonly Learn session evidence is invalid");
  await Promise.all(session.referenceIds.map((id) => loadReferenceDesignDNA(rootPath, session.projectId, id)));
  return expectedStatus === undefined ? saveSession(rootPath, session) : transitionLearnSession(rootPath, expectedStatus, session);
}
export async function listReadonlyLearnSessions(rootPath: string, projectId: string) {
  const sessions = (await listSessions(rootPath, projectId)).filter((session) => session.type === "ASSIMILATION" || session.type === "DESIGN_VERIFY");
  if (!sessions.every(isReadonlyLearnSession)) throw new Error("Readonly Learn session evidence is invalid");
  return sessions as ReadonlyLearnSession[];
}
