import { StatusBadge } from "./status-badge";

export interface SidebarProject {
  id: string;
  name: string;
  status: string;
}

export interface SidebarProps {
  project: SidebarProject;
  activePath: string;
  genome: SidebarGenomeState;
}

export type SidebarGenomeState =
  | { state: "LOADING" }
  | { state: "UNAVAILABLE" }
  | { state: "NOT_INITIALIZED" }
  | {
      state: "INITIALIZED";
      status: "DRAFT" | "APPROVED";
      version: string;
      authority: "NON-AUTHORITATIVE" | "AUTHORITATIVE";
    };

const navigation = [
  {
    label: "Overview",
    path: "overview",
    group: "OVERVIEW",
    mark: "⌂",
  },
  { label: "References", path: "references", group: "SHARINGAN", mark: "◉" },
  { label: "Learn", path: "learn", group: "SHARINGAN", mark: "◎" },
  { label: "Execute", path: "execute", group: "SHARINGAN", mark: "◌" },
  { label: "Govern", path: "govern", group: "SHARINGAN", mark: "∞" },
  { label: "Reports", path: "reports", group: "SYSTEM", mark: "▤" },
  { label: "Settings", path: "settings", group: "SYSTEM", mark: "⚙" },
] as const;

function genomeLabel(genome: SidebarGenomeState): string {
  if (genome.state === "LOADING") return "Checking…";
  if (genome.state === "UNAVAILABLE") return "Unavailable";
  if (genome.state === "NOT_INITIALIZED") return "Not initialized";
  return `${genome.status} · v${genome.version} · ${genome.authority === "AUTHORITATIVE" ? "Authoritative" : "Non-authoritative"}`;
}

export function Sidebar({ project, activePath, genome }: SidebarProps) {
  let previousGroup = "";

  return (
    <aside className="ds-sidebar">
      <div className="ds-sidebar__brand">
        <span className="ds-mark" aria-hidden="true">
          <span />
        </span>
        <span>Design Sharingan</span>
      </div>

      <div className="ds-sidebar__project">
        <p className="ds-nav-label">PROJECT</p>
        <strong>{project.name}</strong>
        <StatusBadge
          tone={project.status === "READY" ? "positive" : "attention"}
        >
          {project.status === "READY" ? "Ready" : "Needs configuration"}
        </StatusBadge>
      </div>

      <nav aria-label="Project workspace">
        {navigation.map((item) => {
          const groupLabel =
            item.group === previousGroup ? null : (
              <p className="ds-nav-label">{item.group}</p>
            );
          previousGroup = item.group;
          const href = `/projects/${encodeURIComponent(project.id)}/${item.path}`;
          const isActive = activePath.endsWith(`/${item.path}`);

          return (
            <div key={item.path}>
              {groupLabel}
              <a className={isActive ? "is-active" : undefined} href={href}>
                <span aria-hidden="true">{item.mark}</span>
                {item.label}
              </a>
            </div>
          );
        })}
      </nav>

      <dl className="ds-sidebar__health">
        <div>
          <dt>Genome</dt>
          <dd>{genomeLabel(genome)}</dd>
        </div>
        <div>
          <dt>Dev server</dt>
          <dd>Idle</dd>
        </div>
        <div>
          <dt>Git state</dt>
          <dd>Not inspected</dd>
        </div>
      </dl>
    </aside>
  );
}
