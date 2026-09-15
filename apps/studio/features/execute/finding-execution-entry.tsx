"use client";
import { useEffect, useState } from "react";
import type { DriftFinding, FeatureBrief, GovernanceFindingSource } from "@design-sharingan/core";
import { useStudioProject } from "../projects/project-shell";
import { EvolveWorkspace } from "../learn/evolve-workspace";
export function FindingExecutionEntry({ findingKey }: { findingKey: string }) {
  const project = useStudioProject();
  const [entry, setEntry] = useState<{ finding: DriftFinding; featureBrief: FeatureBrief; sourceFinding: GovernanceFindingSource }>();
  const [error, setError] = useState<string>();
  useEffect(() => { fetch(`/projects/${encodeURIComponent(project.id)}/govern/finding?finding=${encodeURIComponent(findingKey)}`, { cache: "no-store" }).then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error); setEntry(payload); }).catch((caught) => setError(String(caught.message))); }, [project.id, findingKey]);
  return <><h1>Finding-linked execution</h1><p>Review an approach for this authenticated finding, then explicitly approve its separate mutation proposal. Opening this entry authorizes no code change.</p>{error ? <p role="alert">{error}</p> : entry ? <><section className="genome-rule-group"><h2>{entry.finding.scope}</h2><p>{entry.finding.expectedRule}</p><p>{entry.finding.observedEvidence.join(" ")}</p><p>Audit revision {entry.sourceFinding.reportRevision} · {entry.sourceFinding.evidenceIds.join(", ")}</p></section><EvolveWorkspace initialBrief={entry.featureBrief} findingKey={findingKey} /></> : <p role="status">Authenticating finding evidence…</p>}</>;
}
