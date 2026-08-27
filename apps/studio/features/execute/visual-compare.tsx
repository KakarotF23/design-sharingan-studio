import type {
  MangekyoReferenceView,
  MangekyoRenderView,
} from "./mangekyo-types";

export function VisualCompare({
  projectId,
  references,
  currentRender,
}: {
  projectId: string;
  references: readonly MangekyoReferenceView[];
  currentRender?: MangekyoRenderView;
}) {
  const reference = references[0];
  return (
    <section className="visual-compare" aria-labelledby="visual-compare-title">
      <header>
        <div>
          <p className="utility-label">RENDERED EVIDENCE</p>
          <h2 id="visual-compare-title">Reference / current</h2>
        </div>
        <span>{currentRender?.viewport ?? "Awaiting capture"}</span>
      </header>
      <div className="visual-compare__grid">
        <figure>
          <figcaption>REFERENCE</figcaption>
          {reference ? (
            <img
              alt={`Reference: ${reference.title}`}
              src={`/projects/${encodeURIComponent(projectId)}/references/image/${encodeURIComponent(reference.id)}`}
            />
          ) : (
            <p>No authenticated reference image is available.</p>
          )}
        </figure>
        <figure>
          <figcaption>CURRENT RENDER</figcaption>
          {currentRender ? (
            <img
              alt={`Current render for ${currentRender.route}`}
              src={`/projects/${encodeURIComponent(projectId)}/execute/mangekyo/render/${encodeURIComponent(currentRender.id)}`}
            />
          ) : (
            <p>Start the loop to capture the current rendered state.</p>
          )}
        </figure>
      </div>
    </section>
  );
}
