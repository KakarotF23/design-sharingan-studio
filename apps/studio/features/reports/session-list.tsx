"use client";

import type { ReportSession } from "@design-sharingan/project-adapters";

function displayType(type: ReportSession["type"]): string {
  return type.replaceAll("_", " ");
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: readonly ReportSession[];
  selectedId?: string;
  onSelect(id: string): void;
}) {
  return (
    <section className="session-ledger" aria-labelledby="session-ledger-title">
      <div className="session-ledger__header">
        <div>
          <p className="utility-label">SESSION HISTORY</p>
          <h2 id="session-ledger-title">Saved work</h2>
        </div>
        <span>{sessions.length.toString().padStart(2, "0")}</span>
      </div>
      {sessions.length > 0 ? (
        <ol className="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                aria-pressed={session.id === selectedId}
                onClick={() => onSelect(session.id)}
              >
                <span className="session-list__meta">
                  <span>{session.type}</span>
                  <time dateTime={session.updatedAt}>
                    {new Date(session.updatedAt).toLocaleString()}
                  </time>
                </span>
                <strong>{displayType(session.type)}</strong>
                <span className="session-list__status">{session.result}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="reference-library__empty">No saved sessions yet.</p>
      )}
    </section>
  );
}
