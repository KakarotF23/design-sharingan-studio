import type { DesignDNA } from "@design-sharingan/core";
import { KRAIGrid } from "./krai-grid";

const dnaFields = [
  ["Hierarchy", "hierarchy"],
  ["Layout", "layout"],
  ["Spacing", "spacing"],
  ["Typography", "typography"],
  ["Color logic", "colorLogic"],
  ["Component geometry", "componentGeometry"],
  ["Navigation", "navigation"],
  ["Interaction", "interaction"],
  ["Motion", "motion"],
  ["Density", "density"],
  ["Emotional tone", "emotionalTone"],
  ["Visual weight", "visualWeight"],
] as const;

export function DesignDNAView({ designDNA }: { designDNA: DesignDNA }) {
  return (
    <section className="design-dna" aria-labelledby="design-dna-title">
      <div className="design-dna__header">
        <div>
          <p className="utility-label">STRUCTURED OUTPUT</p>
          <h2 id="design-dna-title">Design DNA</h2>
        </div>
        <span>SCAN / READY</span>
      </div>
      <dl className="design-dna__matrix">
        {dnaFields.map(([label, field]) => (
          <div key={field}>
            <dt>{label}</dt>
            <dd>{designDNA[field].join(" ")}</dd>
          </div>
        ))}
      </dl>
      <KRAIGrid designDNA={designDNA} />
    </section>
  );
}
