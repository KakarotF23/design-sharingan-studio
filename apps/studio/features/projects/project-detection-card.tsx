import Link from "next/link";
import { StatusBadge } from "@design-sharingan/ui";
import { ProjectStatus } from "./project-status";
import {
  projectSessionKey,
  type StudioProjectState,
} from "./project-state";

function frameworkName(framework: string | undefined): string {
  if (framework === "nextjs") return "Next.js";
  if (framework === "vite") return "Vite";
  if (framework === "react") return "React";
  return "Needs configuration";
}

export function ProjectDetectionCard({
  project,
}: {
  project: StudioProjectState;
}) {
  const rememberProject = () => {
    window.sessionStorage.setItem(projectSessionKey(project.id), JSON.stringify(project));
  };

  return (
    <section className="detection" aria-label="Detected configuration">
      <div className="detection__header">
        <div>
          <p className="utility-label">SCAN COMPLETE / USER REVIEW</p>
          <h2>Detected configuration</h2>
        </div>
        <ProjectStatus status={project.status} />
      </div>

      <dl className="detection__manifest">
        <div>
          <dt>Project</dt>
          <dd>{project.name}</dd>
        </div>
        <div>
          <dt>Framework</dt>
          <dd>{frameworkName(project.framework)}</dd>
        </div>
        <div>
          <dt>Package manager</dt>
          <dd>{project.packageManager ?? "Needs configuration"}</dd>
        </div>
        <div>
          <dt>Dev command</dt>
          <dd>{project.devCommand ?? "Needs configuration"}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{project.sourceType === "LOCAL" ? "Local folder" : "GitHub"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{project.status === "READY" ? "Ready" : "Needs configuration"}</dd>
        </div>
      </dl>

      <div className="detection__capabilities" aria-label="Project capabilities">
        <StatusBadge tone={project.capabilities.canReadFiles ? "positive" : "attention"}>
          {project.capabilities.canReadFiles ? "Read ready" : "Read unavailable"}
        </StatusBadge>
        <StatusBadge tone={project.capabilities.canRun ? "positive" : "attention"}>
          {project.capabilities.canRun ? "Runtime ready" : "Runtime unavailable"}
        </StatusBadge>
        <StatusBadge tone={project.capabilities.canRender ? "positive" : "attention"}>
          {project.capabilities.canRender ? "Render ready" : "Render unavailable"}
        </StatusBadge>
        <StatusBadge tone={project.capabilities.canUseGit ? "positive" : "neutral"}>
          {project.capabilities.canUseGit ? "Git ready" : "Git not detected"}
        </StatusBadge>
      </div>

      <Link
        className="primary-action detection__open"
        href={`/projects/${encodeURIComponent(project.id)}/overview`}
        onClick={rememberProject}
      >
        <span>Open Studio</span>
        <span aria-hidden="true">↗</span>
      </Link>
    </section>
  );
}
