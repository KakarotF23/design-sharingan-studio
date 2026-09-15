"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { WorkspaceHeader } from "@design-sharingan/ui";
import { useStudioProject } from "../projects/project-shell";
import { ReferenceCard } from "./reference-card";
import type { ReferenceView } from "./reference-types";

interface ReferenceResponse {
  references?: ReferenceView[];
  reference?: ReferenceView;
  error?: string;
}

export function ReferenceUploader() {
  const project = useStudioProject();
  const [references, setReferences] = useState<ReferenceView[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const endpoint = `/projects/${encodeURIComponent(project.id)}/references/data`;

  const loadReferences = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = (await response.json()) as ReferenceResponse;
    if (!response.ok) throw new Error(payload.error ?? "References are unavailable.");
    setReferences(payload.references ?? []);
  }, [endpoint]);

  useEffect(() => {
    loadReferences().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "References are unavailable.");
    });
  }, [loadReferences]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const form = event.currentTarget;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: new FormData(form),
      });
      const payload = (await response.json()) as ReferenceResponse;
      if (!response.ok || payload.reference === undefined) {
        throw new Error(payload.error ?? "Reference could not be added.");
      }
      setReferences((current) => [payload.reference as ReferenceView, ...current]);
      form.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reference could not be added.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reference-workspace">
      <WorkspaceHeader
        eyebrow={`VISUAL EVIDENCE / ${project.name.toUpperCase()}`}
        title="References"
        description="Collect visual evidence without treating it as a command. Raster uploads are validated before they enter the local project library."
      />
      <div className="reference-workspace__layout">
        <form className="reference-uploader" onSubmit={submit}>
          <div>
            <p className="utility-label">ADD EVIDENCE</p>
            <h2>New reference</h2>
          </div>
          <label>
            <span>Reference image</span>
            <input
              name="image"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              required
            />
            <small>PNG, JPEG, WebP, or GIF · 10 MiB maximum</small>
          </label>
          <label>
            <span>Reference title</span>
            <input name="title" maxLength={120} required />
          </label>
          <label>
            <span>Reference tags</span>
            <input name="tags" placeholder="editorial, calm, navigation" maxLength={1000} />
          </label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="primary-action" type="submit" disabled={busy}>
            <span>{busy ? "Adding reference…" : "Add reference"}</span>
            <span aria-hidden="true">＋</span>
          </button>
        </form>
        <section className="reference-library" aria-labelledby="reference-library-title">
          <div className="reference-library__header">
            <div>
              <p className="utility-label">LOCAL LIBRARY</p>
              <h2 id="reference-library-title">Evidence in this project</h2>
            </div>
            <span>{references.length.toString().padStart(2, "0")}</span>
          </div>
          {references.length > 0 ? (
            <div className="reference-library__grid">
              {references.map((reference) => (
                <ReferenceCard key={reference.id} reference={reference} />
              ))}
            </div>
          ) : (
            <p className="reference-library__empty">No references added yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}
