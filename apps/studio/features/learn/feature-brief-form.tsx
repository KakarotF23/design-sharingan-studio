import type { ReferenceView } from "../references/reference-types";

export function FeatureBriefForm({
  references,
  busy,
}: {
  references: readonly ReferenceView[];
  busy: boolean;
}) {
  const analyzedReferences = references.filter(
    (reference) => reference.analysisStatus === "ANALYZED",
  );

  return (
    <div className="feature-brief-form__fields">
      <label>
        <span>Feature name</span>
        <input name="name" required maxLength={160} />
      </label>
      <label>
        <span>Goal</span>
        <textarea name="goal" required rows={3} maxLength={2000} />
      </label>
      <label>
        <span>Description</span>
        <textarea name="description" required rows={4} maxLength={4000} />
      </label>
      <label>
        <span>Constraints</span>
        <textarea
          name="constraints"
          rows={3}
          maxLength={4000}
          placeholder="One constraint per line"
        />
      </label>
      <label>
        <span>Must keep</span>
        <textarea
          name="mustKeep"
          rows={3}
          maxLength={4000}
          placeholder="One invariant per line"
        />
      </label>
      <label>
        <span>Must not change</span>
        <textarea
          name="mustNotChange"
          rows={3}
          maxLength={4000}
          placeholder="One boundary per line"
        />
      </label>
      <label>
        <span>Success criteria</span>
        <textarea
          name="successCriteria"
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
