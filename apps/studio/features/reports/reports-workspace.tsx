"use client";

import { useEffect, useState } from "react";
import { WorkspaceHeader } from "@design-sharingan/ui";
import { useStudioProject } from "../projects/project-shell";
import type { ReferenceScanSession } from "../references/reference-types";

export function ReportsWorkspace() {
  const project = useStudioProject();
  const [sessions, setSessions] = useState<ReferenceScanSession[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetch(`/projects/${encodeURIComponent(project.id)}/reports/data`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          sessions?: ReferenceScanSession[];
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "Reports are unavailable.");
        setSessions(payload.sessions ?? []);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Reports are unavailable.");
      });
  }, [project.id]);

  return (
    <div className="reports-workspace">
      <WorkspaceHeader
        eyebrow={`EVIDENCE RECORD / ${project.name.toUpperCase()}`}
        title="Reports"
        description="Inspect durable design sessions and the evidence behind their current status."
      />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <section className="session-ledger" aria-labelledby="session-ledger-title">
        <div className="session-ledger__header">
          <div>
            <p className="utility-label">SESSION HISTORY</p>
            <h2 id="session-ledger-title">Saved analysis</h2>
          </div>
          <span>{sessions.length.toString().padStart(2, "0")}</span>
        </div>
        {sessions.length > 0 ? (
          <ol>
            {sessions.map((session) => (
              <li key={session.id}>
                <div>
                  <span>{session.type}</span>
                  <time dateTime={session.createdAt}>
                    {new Date(session.createdAt).toLocaleString()}
                  </time>
                </div>
                <h3>{session.referenceTitle}</h3>
                <p>{session.designDNA.emotionalTone.join(" ")}</p>
                <strong>{session.status}</strong>
              </li>
            ))}
          </ol>
        ) : (
          <p className="reference-library__empty">No saved sessions yet.</p>
        )}
      </section>
    </div>
  );
}
