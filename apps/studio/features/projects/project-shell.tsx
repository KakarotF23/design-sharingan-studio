"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { StudioShell } from "@design-sharingan/ui";
import {
  fallbackProjectState,
  projectSessionKey,
  workspaceDefinitions,
  type StudioProjectState,
  type WorkspaceKind,
} from "./project-state";

const ProjectStateContext = createContext<StudioProjectState | undefined>(
  undefined,
);

function isProjectState(value: unknown, projectId: string): value is StudioProjectState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StudioProjectState>;
  return (
    candidate.id === projectId &&
    typeof candidate.name === "string" &&
    (candidate.sourceType === "LOCAL" || candidate.sourceType === "GITHUB") &&
    (candidate.status === "READY" ||
      candidate.status === "NEEDS_CONFIGURATION") &&
    candidate.capabilities !== null &&
    typeof candidate.capabilities === "object"
  );
}

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
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [project, setProject] = useState<StudioProjectState>(() =>
    fallbackProjectState(projectId),
  );
  const workspace = activeWorkspace(pathname);
  const definition = workspaceDefinitions[workspace];

  useEffect(() => {
    const serialized = window.sessionStorage.getItem(projectSessionKey(projectId));
    if (serialized === null) return;
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (isProjectState(parsed, projectId)) setProject(parsed);
    } catch {
      window.sessionStorage.removeItem(projectSessionKey(projectId));
    }
  }, [projectId]);

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
