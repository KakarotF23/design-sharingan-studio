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
import {
  StudioShell,
  type SidebarGenomeState,
  type StudioMode,
} from "@design-sharingan/ui";
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
const GenomeStateContext = createContext<
  { genome: SidebarGenomeState; setGenome(genome: SidebarGenomeState): void } | undefined
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

export function useStudioGenomeState(): {
  genome: SidebarGenomeState;
  setGenome(genome: SidebarGenomeState): void;
} {
  const state = useContext(GenomeStateContext);
  if (state === undefined) throw new Error("Studio Genome state is unavailable");
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
  const [genome, setGenome] = useState<SidebarGenomeState>({ state: "LOADING" });

  useEffect(() => {
    const controller = new AbortController();
    setGenome({ state: "LOADING" });
    fetch(`/projects/${encodeURIComponent(project.id)}/govern/data`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = await response.json() as {
          initialized?: boolean;
          genome?: {
            status?: "DRAFT" | "APPROVED";
            version?: string;
            authority?: "NON-AUTHORITATIVE" | "AUTHORITATIVE";
          };
        };
        if (!response.ok || value.initialized === undefined) throw new Error("Genome state unavailable");
        if (!value.initialized) return { state: "NOT_INITIALIZED" } as const;
        if (
          value.genome?.status === undefined || value.genome.version === undefined ||
          value.genome.authority === undefined
        ) throw new Error("Genome state incomplete");
        return {
          state: "INITIALIZED",
          status: value.genome.status,
          version: value.genome.version,
          authority: value.genome.authority,
        } as const;
      })
      .then((state) => { if (!controller.signal.aborted) setGenome(state); })
      .catch(() => { if (!controller.signal.aborted) setGenome({ state: "UNAVAILABLE" }); });
    return () => controller.abort();
  }, [project.id]);

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
        label: "Genome",
        value: genome.state === "INITIALIZED"
          ? `${genome.status} · v${genome.version}`
          : genome.state === "NOT_INITIALIZED" ? "Not initialized"
            : genome.state === "UNAVAILABLE" ? "Unavailable" : "Checking…",
      },
      {
        label: "Genome authority",
        value: genome.state === "INITIALIZED" ? genome.authority : "None",
      },
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
    [definition.title, executionMode, genome, project, workspace],
  );

  return (
    <ProjectStateContext.Provider value={project}>
      <ExecutionModeContext.Provider value={{ mode: executionMode, setMode: setExecutionMode }}>
        <GenomeStateContext.Provider value={{ genome, setGenome }}>
          <StudioShell
            project={project}
            activePath={pathname}
            context={context}
            genome={genome}
            activityStatus={
              project.status === "READY"
                ? "Project ready for a deliberate next action"
                : "Project configuration required before execution"
            }
          >
            {children}
          </StudioShell>
        </GenomeStateContext.Provider>
      </ExecutionModeContext.Provider>
    </ProjectStateContext.Provider>
  );
}
