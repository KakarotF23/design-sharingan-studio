"use client";

import type { ReportSession } from "@design-sharingan/project-adapters";

export function RenderPanel({ session }: { session?: ReportSession }) {
  const renders = session?.evidence.filter((evidence) => evidence.kind === "RENDER") ?? [];
  return (
    <section className="report-panel" aria-labelledby="report-render-title">
      <div className="report-panel__header">
        <p className="utility-label">RENDER</p>
        <h2 id="report-render-title">Authenticated captures</h2>
      </div>
      {renders.length > 0 ? (
        <ul className="render-evidence">
          {renders.map((render) => (
            <li id={`report-render-${render.id}`} key={render.id}>
              <span>{render.label ?? render.id}</span>
              <small>Retained render evidence</small>
            </li>
          ))}
        </ul>
      ) : <p>Render evidence is unavailable for this session.</p>}
    </section>
  );
}
