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
import { StudioShell, type StudioMode } from "@design-sharingan/ui";
import {
  workspaceDefinitions,
  type StudioProjectState,
  type WorkspaceKind,
} from "./project-state";

const ProjectStateContext = createContext<StudioProjectState | undefined>(
  undefined,
);
const ExecutionModeContext = createContext<
  { mode: StudioMode; setMode(mode: StudioMode): void } | undefined
>(undefined);

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

export function useStudioExecutionMode(): {
  mode: StudioMode;
  setMode(mode: StudioMode): void;
} {
  const state = useContext(ExecutionModeContext);
  if (state === undefined) throw new Error("Studio execution mode is unavailable");
  return state;
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
  const [executionMode, setExecutionMode] = useState<StudioMode>("SAFE");

  useEffect(() => {
    if (workspace !== "execute") setExecutionMode("SAFE");
  }, [workspace]);

  const context = useMemo(
    () => [
      { label: "Workspace", value: definition.title },
      { label: "Project", value: project.name },
      { label: "Source", value: project.sourceType },
      { label: "Framework", value: project.framework ?? "Unknown" },
      {
        label: "Mode",
        value: workspace === "execute" && executionMode === "MANGEKYO"
          ? "Mangekyō"
          : "Safe",
      },
      {
        label: "Runtime",
        value: project.capabilities.canRun
          ? "Runtime available"
          : "Runtime unavailable",
      },
      {
        label: "Render",
        value: project.capabilities.canRender
          ? "Render available"
          : "Render unavailable",
      },
    ],
    [definition.title, executionMode, project, workspace],
  );

  return (
    <ProjectStateContext.Provider value={project}>
      <ExecutionModeContext.Provider value={{ mode: executionMode, setMode: setExecutionMode }}>
        <StudioShell
          project={project}
          activePath={pathname}
          context={context}
          activityStatus={
            project.status === "READY"
              ? "Project ready for a deliberate next action"
              : "Project configuration required before execution"
          }
        >
          {children}
        </StudioShell>
      </ExecutionModeContext.Provider>
    </ProjectStateContext.Provider>
  );
}
