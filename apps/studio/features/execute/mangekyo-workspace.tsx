"use client";

import { ModeSwitcher, WorkspaceHeader, type StudioMode } from "@design-sharingan/ui";
import { useCallback, useEffect, useState } from "react";
import { useStudioProject } from "../projects/project-shell";
import { AutonomyBoundaryCard } from "./autonomy-boundary-card";
import type { MangekyoDataView, MangekyoSessionView } from "./mangekyo-types";
import { VisualCompare } from "./visual-compare";
import { VisualRoundTimeline } from "./visual-round-timeline";

function findings(session?: MangekyoSessionView) {
  return session?.rounds.at(-1)?.findings ?? [];
}

export function MangekyoWorkspace({
  safeSessionId,
  onModeChange,
}: {
  safeSessionId: string;
  onModeChange(mode: StudioMode): void;
}) {
  const project = useStudioProject();
  const [data, setData] = useState<MangekyoDataView>({ references: [] });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const endpoint = `/projects/${encodeURIComponent(project.id)}/execute/mangekyo`;

  const load = useCallback(async () => {
    const response = await fetch(`${endpoint}/data`, { cache: "no-store" });
    const payload = (await response.json()) as MangekyoDataView & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Mangekyō evidence is unavailable.");
    setData(payload);
  }, [endpoint]);

  useEffect(() => {
    load()
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Mangekyō evidence is unavailable."))
      .finally(() => setLoaded(true));
  }, [load]);

  async function action(path: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`${endpoint}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as MangekyoDataView & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Mangekyō action failed.");
      setData(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Mangekyō action failed.");
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const session = data.session;
  const latestFindings = findings(session);
  return (
    <div className="execute-workspace mangekyo-workspace" aria-busy={busy}>
      <WorkspaceHeader
        eyebrow={`POLICY-BOUNDED LOOP / ${project.name.toUpperCase()}`}
        title="Mangekyō visual loop"
        description="Apply one coherent visual objective at a time, inspect a fresh real render, and stop at every policy boundary. Reference similarity never outranks UX or accessibility."
        actions={<ModeSwitcher mode="MANGEKYO" onChange={onModeChange} />}
      />
      <p className="mangekyo-activity" role="status" aria-live="polite">
        <span aria-hidden="true" />
        {busy ? "Running project, capturing, and comparing fresh evidence" : session?.activity ?? "Ready to establish fresh baseline render evidence"}
      </p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!loaded ? <p className="analysis-status" role="status">Loading visual loop evidence…</p> : null}
      {loaded && session === undefined ? (
        <section className="mangekyo-start" aria-labelledby="mangekyo-start-title">
          <div>
            <p className="utility-label">ENTRY GATE / 5 ROUND BUDGET</p>
            <h2 id="mangekyo-start-title">Establish the rendered baseline</h2>
            <p>Uses the approved direction, explicit default policy, project references, route `/`, and a desktop capture.</p>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={() => void action("start", { safeSessionId })}
          >
            Start Mangekyō loop
          </button>
        </section>
      ) : null}
      {session ? (
        <>
          <section className="mangekyo-round-head" aria-label="Current visual round">
            <div>
              <p className="utility-label">CURRENT ROUND</p>
              <strong>{String(Math.max(1, session.currentRound)).padStart(2, "0")}</strong>
              <span>/ {String(session.maxRounds).padStart(2, "0")}</span>
            </div>
            <dl>
              <div><dt>Status</dt><dd>{session.status}</dd></div>
              <div><dt>Route</dt><dd>{session.route}</dd></div>
              <div><dt>Viewport</dt><dd>{session.viewport}</dd></div>
            </dl>
          </section>
          <VisualCompare
            projectId={project.id}
            references={data.references}
            currentRender={session.currentRender ?? session.initialRender}
          />
          <section className="mangekyo-findings" aria-labelledby="mangekyo-findings-title">
            <header>
              <p className="utility-label">SEVERITY FINDINGS</p>
              <h2 id="mangekyo-findings-title">Rendered review</h2>
            </header>
            {latestFindings.length === 0 ? <p>No open findings in the latest inspected render.</p> : (
              <ol>
                {latestFindings.map((finding) => (
                  <li key={finding.id} data-severity={finding.severity}>
                    <span>{finding.severity}</span>
                    <div><h3>{finding.description}</h3><p>{finding.reason}</p><strong>{finding.recommendedAction}</strong></div>
                  </li>
                ))}
              </ol>
            )}
          </section>
          {session.currentGate ? (
            <AutonomyBoundaryCard
              gate={session.currentGate}
              busy={busy}
              onDecision={(decision) => void action("decision", { sessionId: session.id, decision })}
            />
          ) : null}
          <VisualRoundTimeline rounds={session.rounds} />
        </>
      ) : null}
    </div>
  );
}
