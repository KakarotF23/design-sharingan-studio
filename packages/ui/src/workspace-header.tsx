import type { ReactNode } from "react";

export interface WorkspaceHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}

export function WorkspaceHeader({
  eyebrow,
  title,
  description,
  actions,
}: WorkspaceHeaderProps) {
  return (
    <header className="ds-workspace-header">
      <div>
        <p className="ds-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions === undefined ? null : (
        <div className="ds-workspace-header__actions">{actions}</div>
      )}
    </header>
  );
}
