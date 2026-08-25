export interface ContextEntry {
  label: string;
  value: string;
}

export interface ContextPanelProps {
  title?: string;
  entries: readonly ContextEntry[];
}

export function ContextPanel({ title = "Context", entries }: ContextPanelProps) {
  return (
    <aside className="ds-context" aria-label="Workspace context">
      <p className="ds-nav-label">{title.toUpperCase()}</p>
      <dl>
        {entries.map((entry) => (
          <div key={entry.label}>
            <dt>{entry.label}</dt>
            <dd>{entry.value}</dd>
          </div>
        ))}
      </dl>
      <div className="ds-context__boundary">
        <span aria-hidden="true">◆</span>
        <p>
          Reference intent never outranks UX integrity, consistency, or
          accessibility.
        </p>
      </div>
    </aside>
  );
}
