"use client";

import type { ReportSession } from "@design-sharingan/project-adapters";

export function GitPanel({ session }: { session?: ReportSession }) {
  const git = session?.git;
  return (
    <section
      className="report-panel"
      id={session === undefined ? undefined : `report-git-${session.id}`}
      aria-labelledby="report-git-title"
    >
      <div className="report-panel__header">
        <p className="utility-label">GIT</p>
        <h2 id="report-git-title">Scoped mutation evidence</h2>
      </div>
      {git === undefined ? <p>Git evidence is unavailable for this session.</p> : !git.available ? (
        <p>{git.note ?? "Git evidence was unavailable when this mutation completed."}</p>
      ) : (
        <div className="git-evidence">
          <p>{git.branch === undefined ? "Branch unavailable" : `Branch ${git.branch}`}</p>
          <dl className="git-evidence__facts">
            <div>
              <dt>Status before</dt>
              <dd><pre aria-label="Git status before">{git.statusBefore}</pre></dd>
            </div>
            <div>
              <dt>Status after</dt>
              <dd><pre aria-label="Git status after">{git.statusAfter}</pre></dd>
            </div>
            <div>
              <dt>Diff after</dt>
              <dd><pre aria-label="Git diff after">{git.diffAfter}</pre></dd>
            </div>
          </dl>
          <dl className="git-evidence__truncation" aria-label="Git evidence retention">
            {(["branch", "statusBefore", "statusAfter", "diffAfter"] as const).map((field) => {
              const retention = git.truncation[field];
              return (
                <div key={field}>
                  <dt>{field === "statusBefore" ? "Status before" : field === "statusAfter" ? "Status after" : field === "diffAfter" ? "Diff after" : "Branch"}</dt>
                  <dd>{retention.truncated ? "Truncated" : "Complete"} · {retention.retainedBytes}/{retention.originalBytes} bytes</dd>
                </div>
              );
            })}
          </dl>
        </div>
      )}
    </section>
  );
}
