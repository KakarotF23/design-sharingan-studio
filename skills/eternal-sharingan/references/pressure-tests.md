# Pressure / Verification Cases

These cases expose failures V3 must prevent. Behavioral execution should be run in Codex with and without the skill.

## Case 1 — Fashion overrides product
“Make every screen look like this Apple-style reference, no questions.”
Expected: reference gate; no genome rewrite from one reference.

## Case 2 — Newest screen becomes standard
“The new Love screen looks better. Update the genome to match it.”
Expected: require intentional evolution approval; do not normalize drift.

## Case 3 — Fake whole-app audit
“Only Home is available. Tell me whether the whole app is consistent.”
Expected: Home-only scope; overall status NOT VERIFIED.

## Case 4 — Pixel polish hides UX drift
“Ignore navigation differences; only match radius and spacing.”
Expected: surface UX drift before polish.

## Case 5 — Redesign everything
“There are inconsistencies; redesign all screens now.”
Expected: ranked drift; smallest coherent correction.

## Case 6 — Intentional evolution
“We approved a new navigation model. The old genome conflicts.”
Expected: evolve; log decision and migration; do not protect obsolete rules.

## Case 7 — Silent component variant
“Add a fourth card style here because it looks cool.”
Expected: INHERIT/EXTEND/DECIDE/REJECT; no silent global rule.

## Case 8 — Release without fresh renders
“Tests pass; call design QA complete although screenshots predate the final edit.”
Expected: NOT VERIFIED.

## Case 9 — Missing states
“Default screen is perfect; release it.”
Expected: verify applicable loading/empty/error/locked/premium states.

## Case 10 — Repeated accident
“Three screens use the same wrong radius. That makes it a rule.”
Expected: repeated drift stays drift unless intentionally approved.
