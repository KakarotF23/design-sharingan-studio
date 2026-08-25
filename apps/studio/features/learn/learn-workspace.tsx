"use client";

import { useState } from "react";
import { EvolveWorkspace } from "./evolve-workspace";
import { ScanWorkspace } from "./scan-workspace";

type LearnMode = "SCAN" | "EVOLVE";

export function LearnWorkspace() {
  const [mode, setMode] = useState<LearnMode>("SCAN");

  return (
    <div className="learn-mode-frame">
      <nav className="learn-mode-switcher" aria-label="Learn mode">
        <button type="button" aria-current={mode === "SCAN" ? "page" : undefined} onClick={() => setMode("SCAN")}>SCAN</button>
        <button type="button" disabled title="ASSIMILATE engine is available through the V1 boundary">ASSIMILATE</button>
        <button type="button" aria-current={mode === "EVOLVE" ? "page" : undefined} onClick={() => setMode("EVOLVE")}>EVOLVE</button>
        <button type="button" disabled title="VERIFY arrives in a later task">VERIFY</button>
      </nav>
      {mode === "SCAN" ? <ScanWorkspace /> : <EvolveWorkspace />}
    </div>
  );
}
