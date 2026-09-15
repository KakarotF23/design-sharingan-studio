"use client";

import { useEffect, useState } from "react";
import type { ProjectReport } from "@design-sharingan/project-adapters";

const tabs = ["ACTIVITY", "AGENT", "RENDER", "GIT"] as const;
type ActivityTab = (typeof tabs)[number];

export function StudioActivityPanel({
  projectId,
  currentStatus,
}: {
  projectId: string;
  currentStatus: string;
}) {
  const [activeTab, setActiveTab] = useState<ActivityTab>("ACTIVITY");
  const [report, setReport] = useState<ProjectReport>();

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/projects/${encodeURIComponent(projectId)}/reports/data?offset=0&limit=5`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => response.ok ? response.json() as Promise<ProjectReport> : undefined)
      .then((payload) => { if (!controller.signal.aborted) setReport(payload); })
      .catch(() => { if (!controller.signal.aborted) setReport(undefined); });
    return () => controller.abort();
  }, [projectId]);

  const session = report?.sessions[0];
  const activity = report?.activity ?? [];
  const content = activeTab === "ACTIVITY"
    ? activity[0]?.message ?? currentStatus
    : activeTab === "AGENT"
      ? activity.find((event) => event.category === "AGENT")?.message ?? "AGENT channel ready"
      : activeTab === "RENDER"
        ? session?.evidence.find((evidence) => evidence.kind === "RENDER")?.label ?? "RENDER channel ready"
        : session?.git === undefined
          ? "GIT channel ready"
          : session.git.available
            ? "Redacted Git evidence is available in Reports."
            : session.git.note ?? "GIT channel ready";

  return (
    <aside className="ds-activity" aria-label="Workspace activity">
      <div className="ds-activity__tabs" role="group" aria-label="Evidence channels">
        {tabs.map((tab) => (
          <button key={tab} type="button" aria-pressed={activeTab === tab} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </div>
      <div className="ds-activity__state" aria-live="polite">
        <span className="ds-pulse" aria-hidden="true" />
        <span>{content}</span>
      </div>
    </aside>
  );
}
