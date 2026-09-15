"use client";
import { useEffect, useState } from "react";
import { WorkspaceHeader } from "@design-sharingan/ui";
import type { ProjectReport } from "@design-sharingan/project-adapters";
import type { GovernanceProjection } from "@design-sharingan/eternal-engine";
import { useStudioProject } from "./project-shell";
type Overview = { referenceCount: number; report: ProjectReport; governance: GovernanceProjection };
export function OverviewWorkspace() {
  const project = useStudioProject();
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const [evidence, setEvidence] = useState<Overview>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    fetch(`${base}/overview/data`, { cache: "no-store" }).then(async (response) => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      if (!disposed) setEvidence(data);
    }).catch((caught: unknown) => { if (!disposed) setError(caught instanceof Error ? caught.message : "Evidence unavailable."); });
    return () => { disposed = true; };
  }, [base]);
  const governed = evidence?.governance.initialized ? evidence.governance : undefined;
  const latestRender = evidence?.report.sessions.find((session) => session.evidence.some(({ kind }) => kind === "RENDER"));
  return <div className="workspace-placeholder" aria-busy={!evidence && !error}>
    <WorkspaceHeader eyebrow={`PROJECT / ${project.name.toUpperCase()}`} title="Overview" description="Current product context, authenticated evidence and the next human decision. A scoped result is never a whole-product health claim." />
    <nav className="workspace-placeholder__grid" aria-label="Overview actions"><a className="secondary-action" href={`${base}/learn`}>Analyze Reference</a><a className="secondary-action" href={`${base}/execute`}>Improve Screen</a><a className="secondary-action" href={`${base}/govern`}>Audit Product</a></nav>
    {error ? <p role="alert">{error}</p> : <p role="status" aria-live="polite">{evidence ? "Saved evidence loaded." : "Authenticating saved evidence…"}</p>}
    {evidence ? <><dl className="drift-view__summary"><div><dt>References</dt><dd>{evidence.referenceCount}</dd></div><div><dt>Saved sessions</dt><dd>{evidence.report.total}</dd></div><div><dt>Registered screens</dt><dd>{governed?.screens.length ?? "Not initialized"}</dd></div><div><dt>Design Genome</dt><dd>{governed ? `${governed.genome.status === "APPROVED" ? "Approved" : "Draft"} · v${governed.genome.version}` : "Not initialized"}</dd></div></dl>
      <section className="genome-rule-group"><h2>Product governance</h2><p>{governed?.release ? `Release gate: ${governed.release.status} · ${governed.drift!.requestedScope.replaceAll("_", " ")}` : "Release gate: NOT VERIFIED"}</p><p>{governed?.drift ? `Inspected: ${governed.drift.inspectedScope.join(", ") || "none"}. Unavailable: ${governed.drift.unavailableScope.length}; unverified checks: ${governed.drift.unverifiedScope.length}.` : "No authenticated audit has been recorded."}</p><p>{latestRender ? `Recent render evidence: ${new Date(latestRender.updatedAt).toLocaleString()}. Open Reports for exact files and scope.` : "No render is present in the recent evidence window."}</p></section>
      <section className="genome-rule-group"><h2>Recent evidence</h2>{evidence.report.sessions.length ? <ul>{evidence.report.sessions.map((session) => <li key={session.id}><a href={`${base}/reports`}>{session.type.replaceAll("_", " ")} · {session.result}</a> — {session.evidence.length} evidence links · {new Date(session.updatedAt).toLocaleString()}</li>)}</ul> : <p>No sessions yet. Analyze a reference to begin.</p>}<a href={`${base}/reports`}>View all Reports</a></section>
    </> : null}
  </div>;
}
