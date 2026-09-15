"use client";

import { useState } from "react";
import { EvolveWorkspace } from "./evolve-workspace";
import { ScanWorkspace } from "./scan-workspace";
import { ReadonlyWorkspace } from "./readonly-workspace";

type LearnMode = "SCAN" | "EVOLVE" | "ASSIMILATION" | "DESIGN_VERIFY";

export function LearnWorkspace() {
  const [mode, setMode] = useState<LearnMode>("SCAN");

  return (
    <div className="learn-mode-frame">
      <nav className="learn-mode-switcher" aria-label="Learn mode">
        <button type="button" aria-current={mode === "SCAN" ? "page" : undefined} onClick={() => setMode("SCAN")}>SCAN</button>
        <button type="button" aria-current={mode === "ASSIMILATION" ? "page" : undefined} onClick={() => setMode("ASSIMILATION")}>ASSIMILATE</button>
        <button type="button" aria-current={mode === "EVOLVE" ? "page" : undefined} onClick={() => setMode("EVOLVE")}>EVOLVE</button>
        <button type="button" aria-current={mode === "DESIGN_VERIFY" ? "page" : undefined} onClick={() => setMode("DESIGN_VERIFY")}>VERIFY</button>
      </nav>
      {mode === "SCAN" ? <ScanWorkspace /> : mode === "EVOLVE" ? <EvolveWorkspace /> : <ReadonlyWorkspace mode={mode} />}
    </div>
  );
}
