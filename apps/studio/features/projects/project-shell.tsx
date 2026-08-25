"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { StudioShell } from "@design-sharingan/ui";
import {
  workspaceDefinitions,
  type StudioProjectState,
  type WorkspaceKind,
} from "./project-state";

const ProjectStateContext = createContext<StudioProjectState | undefined>(
  undefined,
);

function activeWorkspace(pathname: string): WorkspaceKind {
  const segment = pathname.split("/").filter(Boolean).at(-1);
  return segment !== undefined && segment in workspaceDefinitions
    ? (segment as WorkspaceKind)
    : "overview";
}

export function useStudioProject(): StudioProjectState {
  const project = useContext(ProjectStateContext);
  if (project === undefined) {
    throw new Error("Project workspace state is unavailable");
  }
  return project;
}

export function ProjectShell({
  project,
  children,
}: {
  project: StudioProjectState;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const workspace = activeWorkspace(pathname);
  const definition = workspaceDefinitions[workspace];

  const context = useMemo(
    () => [
      { label: "Workspace", value: definition.title },
      { label: "Project", value: project.name },
      { label: "Source", value: project.sourceType },
      { label: "Framework", value: project.framework ?? "Unknown" },
      { label: "Mode", value: "Safe" },
      { label: "Evidence", value: "Not collected" },
    ],
    [definition.title, project],
  );

  return (
    <ProjectStateContext.Provider value={project}>
      <StudioShell
        project={project}
        activePath={pathname}
        context={context}
        activityStatus="Project ready for a deliberate next action"
      >
        {children}
      </StudioShell>
    </ProjectStateContext.Provider>
  );
}
