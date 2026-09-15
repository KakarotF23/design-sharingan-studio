"use client";

import type {
  DesignApproach,
  FeatureBrief,
  UXImpact,
} from "@design-sharingan/core";
import { WorkspaceHeader } from "@design-sharingan/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useStudioProject } from "../projects/project-shell";
import type { ReferenceView } from "../references/reference-types";
import { ApproachCard } from "./approach-card";
import { FeatureBriefForm } from "./feature-brief-form";
import { lines } from "./feature-brief";
import { UXImpactMap } from "./ux-impact-map";

interface EvolveSessionView {
  id: string;
  status: "AWAITING_DECISION";
  featureBrief: FeatureBrief;
  referenceIds: string[];
  uxImpact: UXImpact[];
  approaches: DesignApproach[];
}

export function EvolveWorkspace({ initialBrief, findingKey }: { initialBrief?: FeatureBrief; findingKey?: string } = {}) {
  const project = useStudioProject();
  const [references, setReferences] = useState<ReferenceView[]>([]);
  const [session, setSession] = useState<EvolveSessionView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [approvingId, setApprovingId] = useState<string>();
  const resultHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    fetch(`/projects/${encodeURIComponent(project.id)}/references/data`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          references?: ReferenceView[];
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "References are unavailable.");
        setReferences(payload.references ?? []);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "References are unavailable.");
      });
  }, [project.id]);

  useEffect(() => {
    if (session !== undefined) resultHeading.current?.focus();
  }, [session]);

  async function runEvolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    setSession(undefined);
    try {
      const response = await fetch(
        `/projects/${encodeURIComponent(project.id)}/learn/evolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            featureBrief: {
              name: data.get("name"),
              goal: data.get("goal"),
              description: data.get("description"),
              constraints: lines(data.get("constraints")),
              mustKeep: lines(data.get("mustKeep")),
              mustNotChange: lines(data.get("mustNotChange")),
              successCriteria: lines(data.get("successCriteria")),
            },
            referenceIds: data.getAll("referenceIds"),
            ...(findingKey === undefined ? {} : { findingKey }),
          }),
        },
      );
      const payload = (await response.json()) as {
        session?: EvolveSessionView;
        error?: string;
      };
      if (!response.ok || payload.session === undefined) {
        throw new Error(payload.error ?? "Feature EVOLVE failed.");
      }
      setSession(payload.session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Feature EVOLVE failed.");
    } finally {
      setBusy(false);
    }
  }

  async function approve(approachId: string) {
    if (session === undefined) return;
    setApprovingId(approachId);
    setError(undefined);
    try {
      const response = await fetch(
        `/projects/${encodeURIComponent(project.id)}/learn/evolve/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: session.id, approachId }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Approach approval failed.");
      }
      window.location.assign(
        `/projects/${encodeURIComponent(project.id)}/execute`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Approach approval failed.");
      setApprovingId(undefined);
    }
  }

  return (
    <div className="learn-workspace">
      <WorkspaceHeader
        eyebrow={`DESIGN INTELLIGENCE / ${project.name.toUpperCase()}`}
        title="Feature EVOLVE"
        description="Map a complete Feature Brief into UX consequences and comparable directions. Target-project code remains unchanged until a later approved Execute proposal."
      />
      <form
        className="feature-brief-form"
        onSubmit={runEvolve}
        aria-busy={busy}
      >
        <div className="feature-brief-form__intro">
          <p className="utility-label">MODE 03 / EVOLVE</p>
          <h2>Frame the product change</h2>
          <p>
            State the goal, invariants, boundaries, and observable definition of success before comparing implementation directions.
          </p>
        </div>
        <FeatureBriefForm references={references} busy={busy} initialBrief={initialBrief} />
      </form>
      {busy ? <p className="analysis-status" role="status">Mapping routes, components, states, and UX risk…</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {session ? (
        <div className="evolve-results">
          <h2 ref={resultHeading} tabIndex={-1} className="sr-only">Feature EVOLVE result</h2>
          <UXImpactMap impacts={session.uxImpact} />
          <section className="approach-set" aria-labelledby="approach-set-title">
            <div className="approach-set__header">
              <div>
                <p className="utility-label">HUMAN DECISION GATE</p>
                <h2 id="approach-set-title">Design approaches</h2>
              </div>
              <span>APPROVAL REQUIRED</span>
            </div>
            <div className="approach-set__grid">
              {session.approaches.map((approach) => (
                <ApproachCard
                  key={approach.id}
                  approach={approach}
                  busy={approvingId !== undefined}
                  onApprove={approve}
                />
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
