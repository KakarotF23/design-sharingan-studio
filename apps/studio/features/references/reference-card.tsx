import type { ReferenceView } from "./reference-types";

export function ReferenceCard({ reference }: { reference: ReferenceView }) {
  return (
    <article className="reference-card">
      <div className="reference-card__preview">
        <img
          src={`/projects/${encodeURIComponent(reference.projectId)}/references/image/${encodeURIComponent(reference.id)}`}
          alt={`Reference image: ${reference.title}`}
          decoding="async"
          loading="lazy"
        />
        <span>VISUAL / {reference.type.replace("image/", "").toUpperCase()}</span>
      </div>
      <div className="reference-card__body">
        <div className="reference-card__status">
          <span>{reference.analysisStatus}</span>
          <span>{new Date(reference.createdAt).toLocaleDateString()}</span>
        </div>
        <h2>{reference.title}</h2>
        {reference.tags.length > 0 ? (
          <ul aria-label="Reference tags">
            {reference.tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        ) : (
          <p>No tags recorded</p>
        )}
      </div>
    </article>
  );
}
