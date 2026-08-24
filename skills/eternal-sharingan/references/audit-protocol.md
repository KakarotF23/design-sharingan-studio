# Product Audit Protocol

## Evidence Set

Before a multi-screen audit:
- enumerate screens/states in scope;
- mark each INSPECTED / UNAVAILABLE / OUT OF SCOPE;
- use current rendered evidence where available;
- never substitute source code for a rendered-state claim.

## Severity

**CRITICAL**
- navigation/task completion harmed;
- accessibility regression;
- misleading hierarchy;
- primary surface breaks core product identity.

**IMPORTANT**
- visible unapproved cross-screen rule divergence;
- duplicated component language;
- foreign reference style redefining the product;
- important required states missing/inconsistent.

**POLISH**
- low-risk spacing, alignment, rhythm, or styling cleanup.

**INTENTIONAL**
- documented exception backed by an approved decision.

## Audit Order
1. UX/navigation integrity
2. Accessibility and required states
3. Product identity / screen-family consistency
4. Component/token consistency
5. Visual hierarchy
6. Motion
7. Pixel-level polish

Update `DRIFT-REPORT.md`. Never claim “whole app audited” if any claimed area was not inspected.
