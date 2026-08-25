"use client";

import { useState } from "react";

const tabs = ["ACTIVITY", "AGENT", "RENDER", "GIT"] as const;
type ActivityTab = (typeof tabs)[number];

export interface ActivityPanelProps {
  currentStatus: string;
}

export function ActivityPanel({ currentStatus }: ActivityPanelProps) {
  const [activeTab, setActiveTab] = useState<ActivityTab>("ACTIVITY");

  return (
    <aside className="ds-activity" aria-label="Workspace activity">
      <div className="ds-activity__tabs" role="tablist" aria-label="Evidence channels">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="ds-activity__state" role="tabpanel">
        <span className="ds-pulse" aria-hidden="true" />
        <span>{activeTab === "ACTIVITY" ? currentStatus : `${activeTab} channel ready`}</span>
      </div>
    </aside>
  );
}
