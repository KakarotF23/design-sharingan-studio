"use client";

import type { ReportSession } from "@design-sharingan/project-adapters";

function evidenceHref(
  projectId: string,
  session: ReportSession,
  evidence: ReportSession["evidence"][number],
): string {
  switch (evidence.kind) {
    case "REFERENCE":
      return `/projects/${encodeURIComponent(projectId)}/references#reference-${encodeURIComponent(evidence.id)}`;
    case "RENDER":
      return `#report-render-${encodeURIComponent(evidence.id)}`;
    case "GIT":
      return `#report-git-${encodeURIComponent(session.id)}`;
    case "APPROVAL":
      return `#report-approvals-${encodeURIComponent(session.id)}`;
    case "GOVERNANCE":
    case "SESSION":
      return evidence.id === session.id
        ? `#report-session-${encodeURIComponent(session.id)}`
        : `/projects/${encodeURIComponent(projectId)}/reports?session=${encodeURIComponent(evidence.id)}#report-session-${encodeURIComponent(evidence.id)}`;
  }
}

function duration(milliseconds: number): string {
  if (milliseconds < 1_000) return "Under one second";
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)} sec`;
  return `${Math.floor(milliseconds / 60_000)} min ${Math.round((milliseconds % 60_000) / 1_000)} sec`;
}

export function SessionDetail({
  projectId,
  session,
}: {
  projectId: string;
  session?: ReportSession;
}) {
  if (session === undefined) {
    return (
      <section className="session-detail session-detail--empty" aria-live="polite">
        <p className="utility-label">INSPECTOR</p>
        <h2>Select a saved session</h2>
        <p>Reports only show retained, authenticated evidence for the active project.</p>
      </section>
    );
  }
  return (
    <section
      className="session-detail"
      id={`report-session-${session.id}`}
      aria-labelledby="session-detail-title"
    >
      <div className="session-detail__header">
        <div>
          <p className="utility-label">SESSION INSPECTOR</p>
          <h2 id="session-detail-title">{session.type.replaceAll("_", " ")}</h2>
        </div>
        <strong>{session.result}</strong>
      </div>
      <dl className="session-detail__facts">
        <div><dt>Result</dt><dd>{session.result}</dd></div>
        <div><dt>Duration</dt><dd>{duration(session.durationMs)}</dd></div>
        <div><dt>Visual rounds</dt><dd>{session.visualRounds}</dd></div>
        <div><dt>Changed files</dt><dd>{session.filesChanged.length}</dd></div>
      </dl>
      {session.error ? (
        <div className="session-detail__group session-detail__error" role="alert">
          <p className="utility-label">ERROR EVIDENCE</p>
          <pre>{session.error}</pre>
        </div>
      ) : null}
      <div className="session-detail__group session-detail__evidence">
        <p className="utility-label">LINKED EVIDENCE</p>
        {session.evidence.length > 0 ? (
          <ul>
            {session.evidence.map((evidence) => (
              <li key={`${evidence.kind}:${evidence.id}`}>
                <a href={evidenceHref(projectId, session, evidence)}>
                  {evidence.label ?? evidence.kind}
                </a>
                <span>{evidence.kind}</span>
              </li>
            ))}
          </ul>
        ) : <p>Evidence is unavailable for this retained record.</p>}
      </div>
      <div
        className="session-detail__group"
        id={`report-approvals-${session.id}`}
      >
        <p className="utility-label">APPROVALS</p>
        {session.approvals.length > 0 ? (
          <ul>
            {session.approvals.map((approval) => (
              <li key={approval.id}>
                <span>{approval.decision}</span>
                <time dateTime={approval.occurredAt}>{new Date(approval.occurredAt).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        ) : <p>No human decision is recorded for this session.</p>}
      </div>
      <div className="session-detail__group">
        <p className="utility-label">FILES CHANGED</p>
        {session.filesChanged.length > 0 ? (
          <ul className="session-detail__files">
            {session.filesChanged.map((file) => <li key={file}>{file}</li>)}
          </ul>
        ) : <p>No authenticated mutation evidence is available.</p>}
      </div>
    </section>
  );
}
