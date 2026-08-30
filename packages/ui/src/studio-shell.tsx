import type { ReactNode } from "react";
import { ActivityPanel } from "./activity-panel";
import { ContextPanel, type ContextEntry } from "./context-panel";
import { Sidebar, type SidebarGenomeState, type SidebarProject } from "./sidebar";

export interface StudioShellProps {
  project: SidebarProject;
  activePath: string;
  context: readonly ContextEntry[];
  activityStatus: string;
  genome: SidebarGenomeState;
  children: ReactNode;
}

export function StudioShell({
  project,
  activePath,
  context,
  activityStatus,
  genome,
  children,
}: StudioShellProps) {
  return (
    <div className="ds-shell">
      <Sidebar project={project} activePath={activePath} genome={genome} />
      <main className="ds-workspace">{children}</main>
      <ContextPanel entries={context} />
      <ActivityPanel currentStatus={activityStatus} />
    </div>
  );
}
