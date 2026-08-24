# Governance Model

## Four Layers

1. **Genome** — stable principles and invariants.
2. **Registry** — where rules are inherited or intentionally overridden.
3. **Decisions** — why the product language changed.
4. **Evidence** — rendered states proving what actually exists.

A product is governed only when all four agree.

## Drift vs Evolution

**Drift** is unplanned divergence: local variants without reasons, foreign references copied too literally, inconsistent density/type/motion/state treatment, or UX hierarchy changed without a product decision.

**Evolution** is intentional: purpose is explicit, scope is approved, migration impact is understood, decision is recorded, and genome/registry update together.

Never retroactively call drift “evolution” to avoid fixing it.

## `init`

Inspect representative screens, tokens, navigation, shared components, current design docs, and major states. Separate repeated patterns from accidents. Propose the initial genome, marking uncertainty **UNCONFIRMED**. Get human approval before making it authoritative.

## `guard`

Return:
- **INHERIT** — patterns the screen must reuse
- **EXTEND** — variation allowed within current rules
- **DECIDE** — genuinely new rule requiring approval
- **REJECT** — conflict with current genome
- **VERIFY** — rendered states required before completion

## `evolve`

Require:
1. explicit approved intent;
2. affected screens/components;
3. migration impact;
4. a Design Decision Record;
5. genome and registry changes;
6. a plan to remove competing obsolete patterns.

## Smallest Coherent Correction

Do not default to a giant redesign. Fix the smallest related rule set that restores coherence. If several screens share the same accidental drift, correct the shared source where practical.
