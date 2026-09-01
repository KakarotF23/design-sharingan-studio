"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProjectReport } from "@design-sharingan/project-adapters";
import { WorkspaceHeader } from "@design-sharingan/ui";
import { GitPanel } from "../activity/git-panel";
import { ProjectActivityPanel } from "../activity/activity-panel";
import { RenderPanel } from "../activity/render-panel";
import { useStudioProject } from "../projects/project-shell";
import { SessionDetail } from "./session-detail";
import { SessionList } from "./session-list";

const emptyReport: ProjectReport = {
  total: 0,
  offset: 0,
  limit: 25,
  sessions: [],
  activity: [],
};

export function ReportsWorkspace() {
  const project = useStudioProject();
  const [report, setReport] = useState<ProjectReport>(emptyReport);
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    fetch(`/projects/${encodeURIComponent(project.id)}/reports/data?offset=0&limit=25`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          sessions?: ProjectReport["sessions"];
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "Reports are unavailable.");
        return payload as ProjectReport;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setReport(payload);
        setSelectedId((current) =>
          payload.sessions.some((session) => session.id === current)
            ? current
            : payload.sessions[0]?.id,
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Reports are unavailable.");
        }
      });
    return () => controller.abort();
  }, [project.id]);

  const selected = useMemo(
    () => report.sessions.find((session) => session.id === selectedId),
    [report.sessions, selectedId],
  );

  return (
    <div className="reports-workspace">
      <WorkspaceHeader
        eyebrow={`EVIDENCE RECORD / ${project.name.toUpperCase()}`}
        title="Reports"
        description="Read-only inspection of retained sessions and authenticated evidence for this project. Results never imply unobserved verification."
      />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="reports-workspace__grid">
        <SessionList sessions={report.sessions} selectedId={selectedId} onSelect={setSelectedId} />
        <SessionDetail session={selected} />
      </div>
      <div className="reports-workspace__panels">
        <ProjectActivityPanel events={report.activity} />
        <RenderPanel session={selected} />
        <GitPanel session={selected} />
      </div>
    </div>
  );
}
