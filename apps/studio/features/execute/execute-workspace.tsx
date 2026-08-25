"use client";

import type { DesignApproach, FeatureBrief } from "@design-sharingan/core";
import { ModeSwitcher, WorkspaceHeader } from "@design-sharingan/ui";
import { useEffect, useState } from "react";
import { useStudioProject } from "../projects/project-shell";

interface ExecuteDirection {
  id: string;
  status: "IDLE";
  sourceSessionId: string;
  approvedApproachId: string;
  approvalId: string;
  featureBrief: FeatureBrief;
  designApproach: DesignApproach;
}

export function ExecuteWorkspace() {
  const project = useStudioProject();
  const [direction, setDirection] = useState<ExecuteDirection>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetch(`/projects/${encodeURIComponent(project.id)}/execute/data`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          executeSession?: ExecuteDirection;
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "Approved direction is unavailable.");
        setDirection(payload.executeSession);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Approved direction is unavailable.");
      })
      .finally(() => setLoaded(true));
  }, [project.id]);

  return (
    <div className="execute-workspace">
      <WorkspaceHeader
        eyebrow={`BOUNDED CHANGE / ${project.name.toUpperCase()}`}
        title="Execute"
        description="The approved design direction is input to a new Safe Mode proposal. Approval here does not authorize a code mutation."
        actions={<ModeSwitcher mode="SAFE" />}
      />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!loaded ? <p className="analysis-status" role="status">Loading approved direction…</p> : null}
      {loaded && direction === undefined && error === undefined ? (
        <p className="reference-library__empty">No approved Feature EVOLVE direction yet.</p>
      ) : null}
      {direction ? (
        <section className="approved-direction" aria-labelledby="approved-direction-title">
          <div className="approved-direction__header">
            <div>
              <p className="utility-label">APPROVED DIRECTION</p>
              <h2 id="approved-direction-title">Approved direction</h2>
            </div>
            <strong>Ready for change proposal</strong>
          </div>
          <div className="approved-direction__body">
            <div>
              <span>Feature Brief</span>
              <h3>{direction.featureBrief.name}</h3>
              <p>{direction.featureBrief.goal}</p>
            </div>
            <div>
              <span>Selected approach</span>
              <h3>{direction.designApproach.title}</h3>
              <p>{direction.designApproach.summary}</p>
            </div>
          </div>
          <dl className="approved-direction__evidence">
            <div><dt>Approval</dt><dd>{direction.approvalId}</dd></div>
            <div><dt>Source session</dt><dd>{direction.sourceSessionId}</dd></div>
            <div><dt>Genome fit</dt><dd>{direction.designApproach.genomeFit}</dd></div>
            <div><dt>Likely files</dt><dd>{direction.designApproach.likelyFiles.join(", ")}</dd></div>
          </dl>
        </section>
      ) : null}
    </div>
  );
}
