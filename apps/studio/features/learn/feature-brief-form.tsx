import type { ReferenceView } from "../references/reference-types";
import type { FeatureBrief } from "@design-sharingan/core";

export function FeatureBriefForm({
  references,
  busy,
  initialBrief,
}: {
  references: readonly ReferenceView[];
  busy: boolean;
  initialBrief?: FeatureBrief;
}) {
  const analyzedReferences = references.filter(
    (reference) => reference.analysisStatus === "ANALYZED",
  );

  return (
    <div className="feature-brief-form__fields">
      <label>
        <span>Feature name</span>
        <input name="name" required maxLength={160} defaultValue={initialBrief?.name} />
      </label>
      <label>
        <span>Goal</span>
        <textarea name="goal" required rows={3} maxLength={2000} defaultValue={initialBrief?.goal} />
      </label>
      <label>
        <span>Description</span>
        <textarea name="description" required rows={4} maxLength={4000} defaultValue={initialBrief?.description} />
      </label>
      <label>
        <span>Constraints</span>
        <textarea
          name="constraints"
          defaultValue={initialBrief?.constraints.join("\n")}
          rows={3}
          maxLength={4000}
          placeholder="One constraint per line"
        />
      </label>
      <label>
        <span>Must keep</span>
        <textarea
          name="mustKeep"
          defaultValue={initialBrief?.mustKeep.join("\n")}
          rows={3}
          maxLength={4000}
          placeholder="One invariant per line"
        />
      </label>
      <label>
        <span>Must not change</span>
        <textarea
          name="mustNotChange"
          defaultValue={initialBrief?.mustNotChange.join("\n")}
          rows={3}
          maxLength={4000}
          placeholder="One boundary per line"
        />
      </label>
      <label>
        <span>Success criteria</span>
        <textarea
          name="successCriteria"
          defaultValue={initialBrief?.successCriteria.join("\n")}
          required
          rows={3}
          maxLength={4000}
          placeholder="One observable outcome per line"
        />
      </label>
      <fieldset className="feature-brief-form__references">
        <legend>Optional reference evidence</legend>
        {analyzedReferences.length > 0 ? (
          analyzedReferences.map((reference) => (
            <label key={reference.id}>
              <input type="checkbox" name="referenceIds" value={reference.id} />
              <span>{reference.title}</span>
            </label>
          ))
        ) : (
          <p>No analyzed references available. EVOLVE can use project context alone.</p>
        )}
      </fieldset>
      <button className="primary-action" type="submit" disabled={busy}>
        <span>{busy ? "Mapping feature impact…" : "Run EVOLVE"}</span>
        <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}
