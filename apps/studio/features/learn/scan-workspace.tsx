"use client";

import type { DesignDNA } from "@design-sharingan/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { WorkspaceHeader } from "@design-sharingan/ui";
import { useStudioProject } from "../projects/project-shell";
import type { ReferenceView } from "../references/reference-types";
import { DesignDNAView } from "./design-dna-view";

interface ReferencePayload {
  references?: ReferenceView[];
  error?: string;
}

interface ScanPayload {
  designDNA?: DesignDNA;
  error?: string;
}

export function ScanWorkspace() {
  const project = useStudioProject();
  const [references, setReferences] = useState<ReferenceView[]>([]);
  const [designDNA, setDesignDNA] = useState<DesignDNA>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => { if (designDNA) resultRef.current?.focus(); }, [designDNA]);

  useEffect(() => {
    fetch(`/projects/${encodeURIComponent(project.id)}/references/data`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as ReferencePayload;
        if (!response.ok) throw new Error(payload.error ?? "References are unavailable.");
        setReferences(payload.references ?? []);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "References are unavailable.");
      });
  }, [project.id]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    setDesignDNA(undefined);
    try {
      const response = await fetch(
        `/projects/${encodeURIComponent(project.id)}/learn/scan`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            referenceId: data.get("referenceId"),
            likes: data.get("likes"),
            dislikes: data.get("dislikes"),
            notes: data.get("notes"),
            analyzeForMe: data.get("analyzeForMe") === "on",
          }),
        },
      );
      const payload = (await response.json()) as ScanPayload;
      if (!response.ok || payload.designDNA === undefined) {
        throw new Error(payload.error ?? "Reference analysis failed.");
      }
      setDesignDNA(payload.designDNA);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reference analysis failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="learn-workspace" aria-busy={busy}>
      <WorkspaceHeader
        eyebrow={`DESIGN INTELLIGENCE / ${project.name.toUpperCase()}`}
        title="Learn"
        description="SCAN extracts product-fit principles from one reference. It produces reviewable design intelligence and never changes target-project code."
      />
      <form className="scan-console" onSubmit={analyze}>
        <div className="scan-console__intro">
          <p className="utility-label">MODE 01 / SCAN</p>
          <h2>Analyze one reference</h2>
          <p>Tell the system what resonates, or let it form the first evidence-backed reading.</p>
        </div>
        <div className="scan-console__fields">
          <label>
            <span>Reference to analyze</span>
            <select name="referenceId" required defaultValue="">
              <option value="" disabled>Select reference</option>
              {references.map((reference) => (
                <option key={reference.id} value={reference.id}>{reference.title}</option>
              ))}
            </select>
          </label>
          <label>
            <span>What do you like?</span>
            <textarea name="likes" rows={3} maxLength={2000} />
          </label>
          <label>
            <span>What should be avoided?</span>
            <textarea name="dislikes" rows={3} maxLength={2000} />
          </label>
          <label>
            <span>Additional context</span>
            <textarea name="notes" rows={3} maxLength={4000} />
          </label>
          <label className="scan-console__unknown">
            <input name="analyzeForMe" type="checkbox" />
            <span>I don&apos;t know — analyze it for me</span>
          </label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="primary-action" type="submit" disabled={busy || references.length === 0}>
            <span>{busy ? "Analyzing reference…" : "Analyze"}</span>
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </form>
      <p role="status" aria-live="polite">{busy ? "SCAN is analyzing the reference." : designDNA ? "SCAN complete. Review KEEP, REJECT, ADAPT and INVENT." : ""}</p>
      {designDNA ? <section aria-label="SCAN results" tabIndex={-1} ref={resultRef}><DesignDNAView designDNA={designDNA} /></section> : null}
    </div>
  );
}
