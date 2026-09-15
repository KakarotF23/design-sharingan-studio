"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ReadonlyLearnSession } from "@design-sharingan/project-adapters";
import { useStudioProject } from "../projects/project-shell";
import type { ReferenceView } from "../references/reference-types";
import { DesignDNAView } from "./design-dna-view";

export function ReadonlyWorkspace({ mode }: { mode: "ASSIMILATION" | "DESIGN_VERIFY" }) {
  const project = useStudioProject();
  const [references, setReferences] = useState<ReferenceView[]>([]);
  const [session, setSession] = useState<ReadonlyLearnSession>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const resultRef = useRef<HTMLElement>(null);
  const base = `/projects/${encodeURIComponent(project.id)}`;
  useEffect(() => { let active = true; setSession(undefined); Promise.all([fetch(`${base}/references/data`, { cache: "no-store" }), fetch(`${base}/learn/analysis`, { cache: "no-store" })]).then(async ([refs, history]) => { if (!refs.ok || !history.ok) throw new Error("Saved design evidence is unavailable."); const refPayload = await refs.json(); const payload = await history.json() as { sessions: ReadonlyLearnSession[] }; if (active) { setReferences(refPayload.references.filter((ref: ReferenceView) => ["ANALYZED", "ASSIMILATED"].includes(ref.analysisStatus))); setSession(payload.sessions.filter((entry) => entry.type === mode).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]); } }).catch((caught) => { if (active) setError(String(caught.message)); }); return () => { active = false; }; }, [base, mode]);
  useEffect(() => { if (session?.status === "RESULT_READY") resultRef.current?.focus(); }, [session]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError(undefined);
    try { const response = await fetch(`${base}/learn/analysis`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, referenceIds: data.getAll("referenceIds"), intendedDirection: data.get("intendedDirection"), currentDirection: data.get("currentDirection") }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error); setSession(payload.session); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Analysis failed."); } finally { setBusy(false); }
  }
  const result = session?.status === "RESULT_READY" ? session.result : undefined;
  return <div className="learn-workspace"><h1>{mode === "ASSIMILATION" ? "Assimilate references" : "Verify design direction"}</h1><p>Read-only design intelligence. No target-project code changes and no whole-product visual PASS.</p><form className="scan-console" onSubmit={submit} aria-busy={busy}><div className="scan-console__fields">{mode === "ASSIMILATION" ? <fieldset><legend>Select at least two analyzed references</legend>{references.map((reference) => <label key={reference.id}><input type="checkbox" name="referenceIds" value={reference.id} />{reference.title}</label>)}</fieldset> : <><label>Intended design logic<textarea name="intendedDirection" required maxLength={8000} rows={4} /></label><label>Current direction or result<textarea name="currentDirection" required maxLength={8000} rows={4} /></label></>}{error ? <p role="alert">{error}</p> : null}<p role="status" aria-live="polite">{busy ? "Analyzing design evidence…" : ""}</p><button className="primary-action" disabled={busy} type="submit">{mode === "ASSIMILATION" ? "Assimilate references" : "Verify direction"}</button></div></form>{result ? <section ref={resultRef} tabIndex={-1} aria-label="Readonly design result"><h2>{"sourceMap" in result ? "Proposed direction" : "Design direction review"}</h2><p>{result.summary}</p>{"sourceMap" in result ? <><h3>Source map</h3>{result.sourceMap.map((source, index) => <p key={index}>{source.referenceIds.map((id) => references.find((ref) => ref.id === id)?.title ?? id).join(", ")} — {source.role}: {source.principles.join("; ")}</p>)}<DesignDNAView designDNA={result.proposedDirection} /></> : <><p>{result.evidenceScope}</p>{result.findings.map((finding, index) => <article key={index}><h3>{finding.severity} · {finding.principle}</h3><p>{finding.observation}</p><p>{finding.recommendation}</p></article>)}</>}<a href={`${base}/reports`}>View saved evidence in Reports</a></section> : null}</div>;
}
