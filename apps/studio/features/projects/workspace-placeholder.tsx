"use client";

import { ModeSwitcher, WorkspaceHeader } from "@design-sharingan/ui";
import { useStudioGenomeState, useStudioProject } from "./project-shell";
import {
  workspaceDefinitions,
  type WorkspaceKind,
} from "./project-state";

export function WorkspacePlaceholder({ workspace }: { workspace: WorkspaceKind }) {
  const project = useStudioProject();
  const { genome } = useStudioGenomeState();
  const definition = workspaceDefinitions[workspace];
  const signals = definition.signals.map((signal) => {
    if (signal.title !== "Design Genome" && signal.title !== "Genome") return signal;
    return {
      ...signal,
      detail: genome.state === "INITIALIZED"
        ? `${genome.status} · v${genome.version} · ${genome.authority}`
        : genome.state === "NOT_INITIALIZED" ? "Not initialized"
          : genome.state === "UNAVAILABLE" ? "Governance unavailable" : "Checking governance…",
    };
  });

  return (
    <div className="workspace-placeholder">
      <WorkspaceHeader
        eyebrow={`${definition.eyebrow} / ${project.name.toUpperCase()}`}
        title={definition.title}
        description={`${definition.description} Context: ${definition.context}.`}
        actions={workspace === "execute" ? <ModeSwitcher mode="SAFE" /> : undefined}
      />
      <div className="workspace-placeholder__grid">
        {signals.map((signal) => (
          <section key={signal.title}>
            <h2>{signal.title}</h2>
            <p>{signal.detail}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
