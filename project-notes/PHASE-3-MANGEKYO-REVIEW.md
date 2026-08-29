# Phase 3 Review — Mangekyō

**Status:** `PHASE PASS WITH DEBT`

**Accepted through:** `9ee5679` on `codex/design-sharingan-studio-v0-1`

Phase 3 completes Task 11: the policy-bounded Mangekyō visual refinement loop.
The delivered path now covers:

```text
Approved Safe direction → explicit autonomy policy → one bounded proposal
→ ALLOW or Human Gate → isolated exact-scope mutation → real render
→ authenticated visual analysis → deterministic stop decision → durable history
```

The loop supports runnable Git and unversioned Local Folder web projects. It
persists every policy, proposal, decision, mutation, source fingerprint,
render, visual finding, integrity result, Stop request, recovery outcome, and
terminal state required to avoid reconstructing truth from browser memory.

## Final verification evidence

Fresh controller verification on `9ee5679`:

```text
CI=true pnpm exec turbo test --force       PASS — 536 passed, 1 planned SDK smoke skipped; 0 cached
pnpm exec turbo typecheck --force          PASS — 10/10; 0 cached
pnpm exec turbo build --force              PASS — optimized Next.js 16.3.2 build; 0 cached
CI=true pnpm e2e                           PASS — 17/17 Playwright tests in 42.7s
git diff --check                           PASS
git status --short                         PASS — clean before this review document
```

Final independent review:

```text
Task 11 exact-path recovery re-review       READY
Focused replay                              148 executions, 0 failures
Open findings                              0 Critical / 0 Important / 0 Minor
```

## Task 11 acceptance

- One coherent visual objective is proposed per round.
- Every reference remains evidence rather than a command.
- Product-law priority is explicit: UX integrity, product consistency,
  accessibility, visual hierarchy, reference intent, then pixel similarity.
- Style changes may run only under a persisted `ALLOW` policy evaluation.
- Navigation, dependency, deletion, data-model, and protected-path changes
  fail closed at a Human Gate unless the exact scope is explicitly authorized.
- Approve Once is single-use and atomically serialized with Reject, Expand
  Scope, Stop, terminal decisions, and concurrent project starts.
- The approval engine owns target mutation, exact delta validation, source
  capture, Git evidence, rollback ownership, and reconciliation truth.
- Every accepted render is newer than the mutation and matches the exact
  transaction-owned Git or unversioned source fingerprint.
- Missing Genome evidence is `NOT_VERIFIED`; it can never become PASS from an
  empty finding list.
- Durable Stop is visible while work is active, survives reload, and cannot
  lose to a concurrent PASS.
- A renewable exact-owner worker lease prevents duplicate live workers.
  Replaced workers abort before mutation or persistence.
- Interrupted mutation-capable checkpoints recover only from an authenticated
  pending proposal/thread/policy/delta relation. Safe recovery writes exact
  nonempty `RECONCILIATION_REQUIRED`; missing or tampered evidence retains
  ownership fail closed.
- Terminal history is retained separately from the one active project loop.

## Checkpoint commits

- `2763c68` — initial Mangekyō visual refinement loop
- `420889e` — atomic decisions, semantic evidence, local-folder freshness,
  crash checkpoints, immutable image snapshots, Stop, and active-loop history
- `2b09498` — crash-truthful orchestration, transaction-owned fingerprints,
  required-path coverage, recoverable reservations, and polled active UI
- `eb596a3` — Stop/terminal CAS, final-byte validation, bounded source unions,
  and durable worker recovery
- `56c820b` — renewable worker ownership and pre-side-effect owner guards
- `3660264`, `e29c725`, `9ee5679` — fail-closed interrupted-work recovery and
  exact pending-proposal/delta provenance

## Visual evidence

- `.superpowers/sdd/2026-08-24-design-sharingan-studio-v0.1-implementation-plan/task-11-mangekyo-desktop.png`
  — 1280 × 2082
- `.superpowers/sdd/2026-08-24-design-sharingan-studio-v0.1-implementation-plan/task-11-mangekyo-mobile.png`
  — 390 × 3436

Fresh controller inspection found no Critical, Important, or Minor visual
defect. Desktop and mobile show truthful Mangekyō mode, active Stop, Human Gate
actions, three remaining IMPORTANT findings, integrity results, and
`Genome NOT_VERIFIED`. The mobile E2E proves `scrollWidth === clientWidth ===
390` with reachable actions and no horizontal overflow.

The acceptance fixture intentionally finishes blocked rather than claiming a
whole-product PASS: one allowed style round completes, a navigation change
reaches Human Gate, and Stop/Reject paths preserve the remaining findings and
history. This is correct policy behavior.

## Decisions and deviations

- Mangekyō never fabricates a human `Approval`. Autonomous ALLOW and exact
  one-change Human Gate authorization are distinct persisted subjects.
- Architecture boundaries remain intact: React projects state; project
  adapters persist claims/evidence; approval-engine mutates; render-engine
  captures; visual-engine analyzes; mangekyo-engine owns loop transitions.
- Non-Git Local Folder evidence uses the same bounded path/byte/mode hashing as
  Git fingerprints, with every proposed changed path included even when it is
  normally a build-output exclusion.
- Worker recovery is deliberately fail closed. It does not guess whether a
  crashed mutation completed, replay an agent turn, or roll back unknown bytes.

## Debt and remaining risks

- The live production Codex SDK smoke remains intentionally scheduled for Task
  16 and is `NOT VERIFIED`; injected SDK contract tests pass.
- A genuinely interrupted mutation-capable phase can require human
  reconciliation. This is explicit durable evidence, not silent auto-retry.
- A dead worker remains fail closed until its bounded lease expires; the live
  owner renews and verifies ownership throughout long work.
- The repository's approved `"packageManager": "pnpm@10"` shorthand continues
  to emit a non-exact-version warning under pnpm 11.
- Whole-product governance, release gating, and cross-screen drift remain Tasks
  12–16; this one-route loop does not claim those outcomes.

## Recommendation

Approve Phase 3 and proceed to Phase 4 (Tasks 12–16). Task 12 should consume
the exact terminal/history, integrity, remaining-finding, policy, Gate, Stop,
source, and reconciliation evidence without converting `NOT_VERIFIED` or a
blocked one-route result into a Genome or whole-product PASS.
