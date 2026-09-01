"use client";

import type { ReportSession } from "@design-sharingan/project-adapters";

export function GitPanel({ session }: { session?: ReportSession }) {
  const git = session?.git;
  return (
    <section className="report-panel" aria-labelledby="report-git-title">
      <div className="report-panel__header">
        <p className="utility-label">GIT</p>
        <h2 id="report-git-title">Scoped mutation evidence</h2>
      </div>
      {git === undefined ? <p>Git evidence is unavailable for this session.</p> : !git.available ? (
        <p>{git.note ?? "Git evidence was unavailable when this mutation completed."}</p>
      ) : (
        <div className="git-evidence">
          <p>{git.branch === undefined ? "Branch unavailable" : `Branch ${git.branch}`}</p>
          <pre aria-label="Redacted Git diff evidence">{git.diffAfter || "No retained diff evidence."}</pre>
        </div>
      )}
    </section>
  );
}
