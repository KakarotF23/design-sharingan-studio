import type { UXImpact } from "@design-sharingan/core";

export function UXImpactMap({ impacts }: { impacts: readonly UXImpact[] }) {
  return (
    <section className="ux-impact" aria-labelledby="ux-impact-title">
      <div className="ux-impact__header">
        <div>
          <p className="utility-label">FEATURE CONSEQUENCE MAP</p>
          <h2 id="ux-impact-title">UX Impact Map</h2>
        </div>
        <span>{impacts.length.toString().padStart(2, "0")}</span>
      </div>
      <ol>
        {impacts.map((impact, index) => (
          <li key={`${impact.area}-${index}`}>
            <div className="ux-impact__signal">
              <strong>{impact.severity}</strong>
              <span>{impact.decisionRequired ? "DECISION REQUIRED" : "INFORMED"}</span>
            </div>
            <h3>{impact.area}</h3>
            <p>{impact.reason}</p>
            <dl>
              <div>
                <dt>Routes</dt>
                <dd>{impact.affectedRoutes.join(", ") || "No route change"}</dd>
              </div>
              <div>
                <dt>Components</dt>
                <dd>{impact.affectedComponents.join(", ") || "No component change"}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
    </section>
  );
}
