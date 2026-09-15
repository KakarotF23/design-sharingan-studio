"use client";

import type { ChangeProposal } from "@design-sharingan/core";
import { useState, type ReactNode } from "react";

function EvidenceList({
  title,
  values,
  empty,
}: {
  title: string;
  values: string[];
  empty: string;
}) {
  return (
    <section>
      <h3>{title}</h3>
      {values.length > 0 ? (
        <ul>
          {values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}

function ProposalFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ChangeProposalView({ proposal }: { proposal: ChangeProposal }) {
  const [showDiffPlan, setShowDiffPlan] = useState(false);
  const diffPlan = [
    ...proposal.filesToCreate.map((path) => `Create ${path}`),
    ...proposal.filesToModify.map((path) => `Modify ${path}`),
    ...proposal.filesToDelete.map((path) => `Delete ${path}`),
  ];

  return (
    <section className="change-proposal" aria-labelledby="change-proposal-title">
      <header className="change-proposal__header">
        <div>
          <p className="utility-label">HUMAN GATE / CHANGE PROPOSAL</p>
          <h2 id="change-proposal-title">Safe Mode change proposal</h2>
        </div>
        <strong>{proposal.riskLevel} RISK</strong>
      </header>
      <div className="change-proposal__thesis">
        <h3>{proposal.summary}</h3>
        <p>{proposal.reason}</p>
      </div>
      <div className="change-proposal__scope">
        <EvidenceList
          title="Create"
          values={proposal.filesToCreate}
          empty="No new files proposed."
        />
        <EvidenceList
          title="Modify"
          values={proposal.filesToModify}
          empty="No file modifications proposed."
        />
        <EvidenceList
          title="Delete"
          values={proposal.filesToDelete}
          empty="No file deletions proposed."
        />
      </div>
      <dl className="change-proposal__facts">
        <ProposalFact label="Screens">
          {proposal.screensAffected.join(", ") || "No rendered screen impact declared."}
        </ProposalFact>
        <ProposalFact label="Components">
          {proposal.componentsAffected.join(", ") || "No component impact declared."}
        </ProposalFact>
        <ProposalFact label="UX impact">
          {proposal.uxImpact
            .map((impact) => `${impact.severity}: ${impact.area} — ${impact.reason}`)
            .join(" | ")}
        </ProposalFact>
        <ProposalFact label="Visual impact">{proposal.visualImpact}</ProposalFact>
        <ProposalFact label="Policy violations">
          {proposal.policyViolations.join(", ") || "None declared."}
        </ProposalFact>
      </dl>
      <div className="change-proposal__diff-plan">
        <button
          type="button"
          aria-expanded={showDiffPlan}
          onClick={() => setShowDiffPlan((visible) => !visible)}
        >
          View Diff Plan
        </button>
        {showDiffPlan ? (
          <ol>
            {diffPlan.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}
