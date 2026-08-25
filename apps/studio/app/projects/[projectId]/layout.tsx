import {
  detectProject,
  loadProjectMetadata,
} from "@design-sharingan/project-adapters";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import {
  decodeProjectLocator,
  PROJECT_LOCATOR_COOKIE,
} from "../../../features/projects/project-locator";
import { ProjectShell } from "../../../features/projects/project-shell";
import type { StudioProjectState } from "../../../features/projects/project-state";

function validProjectId(projectId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(projectId);
}

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!validProjectId(projectId)) notFound();

  const encodedLocator = (await cookies()).get(PROJECT_LOCATOR_COOKIE)?.value;
  const rootPath =
    encodedLocator === undefined
      ? undefined
      : decodeProjectLocator(encodedLocator);
  if (rootPath === undefined) notFound();

  let project: StudioProjectState;
  try {
    const persisted = await loadProjectMetadata(rootPath, projectId);
    const detection = await detectProject(persisted.rootPath);
    if (detection.rootPath !== persisted.rootPath) {
      throw new Error("Detected project root changed");
    }
    project = {
      id: persisted.id,
      name: persisted.name,
      sourceType: persisted.sourceType,
      status: persisted.status,
      framework: persisted.framework,
      packageManager: persisted.packageManager,
      devCommand: persisted.devCommand,
      capabilities: detection.capabilities,
    };
  } catch {
    notFound();
  }

  return <ProjectShell project={project}>{children}</ProjectShell>;
}
