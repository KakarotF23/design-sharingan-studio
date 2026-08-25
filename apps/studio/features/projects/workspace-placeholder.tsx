"use client";

import { ModeSwitcher, WorkspaceHeader } from "@design-sharingan/ui";
import { useStudioProject } from "./project-shell";
import {
  workspaceDefinitions,
  type WorkspaceKind,
} from "./project-state";

export function WorkspacePlaceholder({ workspace }: { workspace: WorkspaceKind }) {
  const project = useStudioProject();
  const definition = workspaceDefinitions[workspace];

  return (
    <div className="workspace-placeholder">
      <WorkspaceHeader
        eyebrow={`${definition.eyebrow} / ${project.name.toUpperCase()}`}
        title={definition.title}
        description={`${definition.description} Context: ${definition.context}.`}
        actions={workspace === "execute" ? <ModeSwitcher mode="SAFE" /> : undefined}
      />
      <div className="workspace-placeholder__grid">
        {definition.signals.map((signal) => (
          <section key={signal.title}>
            <h2>{signal.title}</h2>
            <p>{signal.detail}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
