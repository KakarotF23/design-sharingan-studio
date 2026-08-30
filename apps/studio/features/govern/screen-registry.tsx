import type { GovernScreenProjection } from "./govern-server";

function RuleList({ values, empty }: { values: string[]; empty: string }) {
  return values.length > 0 ? (
    <ul>
      {values.map((value) => <li key={value}>{value}</li>)}
    </ul>
  ) : (
    <p>{empty}</p>
  );
}

export function ScreenRegistry({ screens }: { screens: GovernScreenProjection[] }) {
  return (
    <section className="screen-registry" aria-labelledby="screen-registry-title">
      <header className="govern-section-heading">
        <div>
          <p className="utility-label">REGISTRY / REPRESENTATIVE SCOPE</p>
          <h2 id="screen-registry-title">Screen Registry</h2>
        </div>
        <span>{screens.length.toString().padStart(2, "0")} SCREENS</span>
      </header>
      {screens.length === 0 ? (
        <p className="govern-empty">No representative screens are registered.</p>
      ) : (
        <ol className="screen-registry__list">
          {screens.map((screen) => (
            <li key={screen.id} className="screen-record">
              <div className="screen-record__identity">
                <div>
                  <span>{screen.route}</span>
                  <h3>{screen.name}</h3>
                </div>
                <dl>
                  <div><dt>Family</dt><dd>{screen.family}</dd></div>
                  <div><dt>Drift</dt><dd>{screen.driftStatus}</dd></div>
                  <div><dt>Last verified</dt><dd>{screen.lastVerified ?? "NOT VERIFIED"}</dd></div>
                </dl>
              </div>
              <div className="screen-record__rules">
                <section>
                  <h4>Inherited rules</h4>
                  <RuleList values={screen.inheritedRules} empty="No inherited rules confirmed." />
                </section>
                <section>
                  <h4>Intentional exceptions</h4>
                  <RuleList values={screen.exceptions} empty="No intentional exceptions recorded." />
                </section>
                <section>
                  <h4>Required states</h4>
                  <RuleList values={screen.requiredStates} empty="No states registered." />
                </section>
                <section>
                  <h4>Evidence</h4>
                  <RuleList values={screen.evidence} empty="No evidence recorded." />
                </section>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
