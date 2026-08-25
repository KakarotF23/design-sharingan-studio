import type { DesignDNA } from "@design-sharingan/core";

const decisions = [
  ["KEEP", "Principles that fit intact", "keep"],
  ["REJECT", "Choices that damage product fit", "reject"],
  ["ADAPT", "Ideas translated into this system", "adapt"],
  ["INVENT", "Needs the reference does not solve", "invent"],
] as const;

export function KRAIGrid({ designDNA }: { designDNA: DesignDNA }) {
  return (
    <div className="krai-grid" aria-label="KEEP REJECT ADAPT INVENT decisions">
      {decisions.map(([title, description, field]) => (
        <section key={field} className={`krai-grid__item krai-grid__item--${field}`}>
          <p>{description}</p>
          <h3>{title}</h3>
          <ul>
            {designDNA[field].map((decision) => (
              <li key={decision}>{decision}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
