import { notFound } from "next/navigation";
import { ProjectShell } from "../../../features/projects/project-shell";

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

  return <ProjectShell projectId={projectId}>{children}</ProjectShell>;
}
