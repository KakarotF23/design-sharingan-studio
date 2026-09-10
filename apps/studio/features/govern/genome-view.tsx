"use client";

import { WorkspaceHeader } from "@design-sharingan/ui";
import { useCallback, useEffect, useState } from "react";
import {
  useStudioGenomeState,
  useStudioProject,
} from "../projects/project-shell";
import type {
  GovernanceProjection,
  GovernGenomeProjection,
  GovernReleaseProjection,
  GovernScreenProjection,
} from "./govern-server";
import { DriftView } from "./drift-view";
import { ReleaseGateView } from "./release-gate-view";
import { ScreenRegistry } from "./screen-registry";
import type { DriftReport } from "@design-sharingan/core";

interface GovernanceResponse {
  initialized?: boolean;
  genome?: GovernGenomeProjection;
  screens?: GovernScreenProjection[];
  drift?: DriftReport;
  release?: GovernReleaseProjection;
  error?: string;
}

function GenomeRuleGroup({
  title,
  values,
  empty = "No confirmed rules.",
  emphasized = false,
}: {
  title: string;
  values: string[];
  empty?: string;
  emphasized?: boolean;
}) {
  return (
    <section className={emphasized ? "genome-rule-group genome-rule-group--unconfirmed" : "genome-rule-group"}>
      <h3>{title}</h3>
      {values.length > 0 ? (
        <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}

export function GenomeView({
  genome,
  busy,
  onApprove,
}: {
  genome: GovernGenomeProjection;
  busy: boolean;
  onApprove(acceptedClaimId: string): void;
}) {
  const [acceptedClaimId, setAcceptedClaimId] = useState<string>();
  return (
    <section className="genome-view" aria-labelledby="genome-title">
      <header className="genome-view__header">
        <div>
          <p className="utility-label">GENOME / VERSION {genome.version}</p>
          <h2 id="genome-title">Design Genome</h2>
          <p>{genome.productIdentity}</p>
        </div>
        <div className="genome-view__authority">
          <span className={`govern-status govern-status--${genome.status.toLowerCase()}`}>
            {genome.status}
          </span>
          <strong>{genome.authority}</strong>
          <small>Revision {genome.revision}</small>
          {genome.status === "DRAFT" ? (
            <button
              className="primary-action"
              type="button"
              disabled={busy || acceptedClaimId === undefined}
              onClick={() => { if (acceptedClaimId !== undefined) onApprove(acceptedClaimId); }}
            >
              <span>{busy ? "Recording approval…" : "Approve Genome"}</span>
              <span aria-hidden="true">→</span>
            </button>
          ) : null}
        </div>
      </header>
      {genome.status === "DRAFT" && genome.approvableClaims.length > 0 ? (
        <fieldset className="genome-rule-group genome-rule-group--unconfirmed">
          <legend>Approve one evidence-bound rule</legend>
          {genome.approvableClaims.map((claim) => (
            <label key={claim.id}>
              <input
                type="radio"
                name="accepted-genome-claim"
                value={claim.id}
                checked={acceptedClaimId === claim.id}
                onChange={() => setAcceptedClaimId(claim.id)}
              />
              {claim.statement}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="genome-view__rules">
        <GenomeRuleGroup title="UX Invariants" values={genome.uxInvariants} />
        <GenomeRuleGroup title="Visual Invariants" values={genome.visualInvariants} />
        <GenomeRuleGroup title="Motion Rules" values={genome.motionRules} />
        <GenomeRuleGroup title="Accessibility Rules" values={genome.accessibilityRules} />
        <GenomeRuleGroup title="Component DNA" values={genome.componentDNA} />
        <GenomeRuleGroup title="Screen Families" values={genome.screenFamilies} />
        <GenomeRuleGroup title="Content Voice" values={genome.contentVoice} />
        <GenomeRuleGroup
          title="Intentional Exceptions"
          values={genome.intentionalExceptions}
          empty="No intentional exceptions recorded."
        />
        <GenomeRuleGroup
          title="Unconfirmed Rules"
          values={genome.unconfirmedRules}
          empty="No unconfirmed rules recorded."
          emphasized
        />
      </div>
    </section>
  );
}

export function GovernWorkspace() {
  const project = useStudioProject();
  const { setGenome: setShellGenome } = useStudioGenomeState();
  const [projection, setProjection] = useState<GovernanceProjection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const response = await fetch(
      `/projects/${encodeURIComponent(project.id)}/govern/data`,
      { cache: "no-store" },
    );
    const payload = (await response.json()) as GovernanceResponse;
    if (!response.ok || payload.initialized === undefined) {
      throw new Error(payload.error ?? "Governance evidence is unavailable.");
    }
    if (!payload.initialized) return { initialized: false } as const;
    if (payload.genome === undefined || payload.screens === undefined) {
      throw new Error("Governance projection is incomplete.");
    }
    return {
      initialized: true,
      genome: payload.genome,
      screens: payload.screens,
      ...(payload.drift === undefined ? {} : { drift: payload.drift }),
      ...(payload.release === undefined ? {} : { release: payload.release }),
    } as GovernanceProjection;
  }, [project.id]);

  useEffect(() => {
    load()
      .then((next) => {
        setProjection(next);
        setShellGenome(next.initialized ? {
          state: "INITIALIZED",
          status: next.genome.status,
          version: next.genome.version,
          authority: next.genome.authority,
        } : { state: "NOT_INITIALIZED" });
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Governance evidence is unavailable.");
      });
  }, [load, setShellGenome]);

  async function action(
    endpoint: "initialize" | "approve" | "audit" | "release",
    acceptedClaimId?: string,
  ) {
    setBusy(true);
    setError(undefined);
    try {
      const body =
        endpoint === "approve" && projection?.initialized
          ? {
              expectedRevision: projection.genome.revision,
              expectedPayloadHash: projection.genome.payloadHash,
              ...(acceptedClaimId === undefined ? {} : { acceptedClaimId }),
            }
          : {};
      const response = await fetch(
        `/projects/${encodeURIComponent(project.id)}/govern/${endpoint}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = (await response.json()) as GovernanceResponse;
      if (
        !response.ok ||
        payload.initialized !== true ||
        payload.genome === undefined ||
        payload.screens === undefined
      ) {
        throw new Error(payload.error ?? "Governance action could not be completed.");
      }
      setProjection({
        initialized: true,
        genome: payload.genome,
        screens: payload.screens,
        ...(payload.drift === undefined ? {} : { drift: payload.drift }),
        ...(payload.release === undefined ? {} : { release: payload.release }),
      });
      setShellGenome({
        state: "INITIALIZED",
        status: payload.genome.status,
        version: payload.genome.version,
        authority: payload.genome.authority,
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Governance action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="govern-workspace" aria-busy={busy}>
      <WorkspaceHeader
        eyebrow={`PRODUCT MEMORY / ${project.name.toUpperCase()}`}
        title="Govern"
        description="Establish human-readable product rules from representative evidence, review uncertainty, and preserve explicit authority boundaries."
      />
      <p className="govern-activity" role="status" aria-live="polite">
        <span aria-hidden="true" />
        {projection?.initialized
          ? projection.genome.authority
          : "NON-AUTHORITATIVE"}
      </p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {projection === undefined && error === undefined ? (
        <p className="analysis-status" role="status">Loading governance evidence…</p>
      ) : null}
      {projection?.initialized === false ? (
        <section className="genome-init">
          <div>
            <p className="utility-label">INIT / HUMAN REVIEW REQUIRED</p>
            <h2>Establish product memory</h2>
            <p>
              Codex will inspect authenticated project context and representative current evidence.
              Every uncertain proposal remains unconfirmed, and the resulting Genome starts DRAFT.
            </p>
          </div>
          <button className="primary-action" type="button" disabled={busy} onClick={() => action("initialize")}>
            <span>{busy ? "Initializing draft…" : "Initialize Draft Genome"}</span>
            <span aria-hidden="true">→</span>
          </button>
        </section>
      ) : null}
      {projection?.initialized ? (
        <>
          <GenomeView
            genome={projection.genome}
            busy={busy}
            onApprove={(acceptedClaimId) => action("approve", acceptedClaimId)}
          />
          <ScreenRegistry screens={projection.screens} />
          <DriftView
            report={projection.drift}
            busy={busy}
            onAudit={() => action("audit")}
            executeHref={`/projects/${encodeURIComponent(project.id)}/execute`}
          />
          <ReleaseGateView
            release={projection.release}
            busy={busy}
            onEvaluate={() => action("release")}
          />
        </>
      ) : null}
    </div>
  );
}
