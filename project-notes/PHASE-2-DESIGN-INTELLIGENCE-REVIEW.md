# Phase 2 Review — Design Intelligence

**Status:** `PHASE PASS WITH DEBT`

**Accepted through:** `ee043f0` on `codex/design-sharingan-studio-v0-1`

Phase 2 implemented and independently reviewed Tasks 7–10 in dependency order:

1. a guarded reference library and read-only Sharingan SCAN workflow;
2. bounded ASSIMILATE/EVOLVE design reasoning, explicit approach approval,
   and a verified Execute handoff;
3. Safe Mode proposal, revision, rejection, approval, and exact-scope mutation;
4. controlled local dev-server lifecycle and fresh Playwright render evidence.

The delivered flow now covers:

```text
Reference → Design DNA → Feature approaches → Human decision
          → Change proposal → Human approval → Bounded mutation
          → Real render artifact with source-freshness evidence
```

Task 11 remains responsible for visual analysis and the bounded autonomous
Mangekyō loop. Task 10 deliberately does not claim visual PASS or mark the Safe
Execution session complete before that consumer exists.

## Verification evidence

Fresh controller verification after the final test-stability checkpoint:

```text
CI=true pnpm test       PASS — 277 passed, 1 planned live SDK smoke skipped
CI=true pnpm typecheck  PASS — 8/8 workspace typechecks
CI=true pnpm build      PASS — Next.js 16.3.2 production build
CI=true pnpm e2e        PASS — 16/16 Playwright tests
git diff --check        PASS
git status --short      PASS — clean
```

Focused final Task 10 evidence:

```text
render-engine tests             PASS — 45/45
project-adapters tests           PASS — 135/135
real render-capture E2E          PASS — 1/1
Task 10 independent re-review    READY — 0 Critical/Important/Minor
```

The real capture acceptance starts a detected local web project, waits for
bounded loopback readiness, captures and validates a 1280×720 PNG, persists the
exact session/round/viewport hierarchy, binds the artifact to a coherent
SHA-256 worktree fingerprint and file count, and proves process-tree shutdown
and temporary-fixture cleanup.

The first fresh phase-gate E2E run exposed a race-prone test assertion that
required observing a short-lived APPROVED UI status. The product had already
advanced truthfully to EDITING. Commit `ee043f0` stabilizes the browser test on
the final durable state; adapter tests continue to prove that APPROVED is
persisted before the mutation callback. Five targeted repeats and the fresh
full E2E run passed.

## Checkpoint commits

- `728c988`, `76aa4f5`, `5638d3d`, `a145169` — Task 7 reference SCAN and
  three provenance/persistence hardening rounds
- `cd3e427`, `4ad5fd7`, `21d2480`, `50f413e` — Task 8 EVOLVE approval,
  provenance hardening, timestamp alignment, and mobile containment
- `655f92c`, `2eae98a`, `4f406d2`, `5a540cb` — Task 9 Safe Mode and three
  security/evidence hardening rounds
- `32e685b`, `10c2ae7`, `9ffafde` — Task 10 render engine and two lifecycle/
  freshness hardening rounds
- `ee043f0` — deterministic Safe Mode completion acceptance

## Important decisions and deviations

- SCAN uses the plan's exact scalar structured-output wire schema, then
  normalizes those fields into the existing array-based `DesignDNA` domain
  contract before persistence.
- Reference uploads are non-empty, signature-matched PNG/JPEG/WebP/GIF files
  up to 10 MiB. SVG and ambiguous content fail closed.
- ASSIMILATE and EVOLVE remain read-only. EVOLVE produces 2–3 bounded design
  approaches with exactly one recommendation; a selected approach requires an
  explicit `DESIGN_APPROACH` Approval before Execute can consume it.
- Task 8 creates a Safe Execution draft because Task 11 Mangekyō autonomy does
  not exist yet. It does not advertise unavailable autonomous execution.
- Safe Mode persists a separate `CHANGE_PROPOSAL` Approval before mutation.
  The agent edits only an executor-owned disjoint mirror; the approval engine
  validates the exact create/modify/delete delta before applying it to the
  target.
- Mutation execution is serialized per canonical target workspace. Rollback
  restores only bytes and modes still owned by that transaction. Indeterminate
  external-writer or rollback outcomes retain the Approval in a durable
  reconciliation-required state and block replay.
- Every approved mutation path produces one bounded authoritative executor-
  captured delta. Git status remains separately labeled as observational
  evidence, so index flags cannot suppress the approved before/after proof.
- Generic Safe Mode cannot mutate `.git`, `.design-sharingan`,
  `design-governance`, environment files, or other protected paths. Ordinary
  deletion still requires an exact same-proposal human approval.
- Task 10 extends `RenderArtifact` with round/viewport/source-revision evidence
  at its first producer boundary. Git renders require a complete coherent
  fingerprint; non-Git renders state that version evidence is unavailable.
- Render freshness includes bounded root and nested ignored `.env*` bytes only
  in the aggregate hash; secret contents and filenames are not persisted.
  Source symlinks, hidden index flags, partial evidence, or concurrent source
  changes fail closed.
- Task 10 exposes a reusable engine rather than adding an unplanned Studio
  orchestration route or advancing Task 9 beyond truthful EDITING. This follows
  the approved task boundary; Task 11 is the first render-evidence consumer.

## Security and failure-boundary review

Independent reviews reproduced and closed failures involving:

- upload MIME inheritance, target/staging overlap, and false SCAN provenance;
- duplicate approach approvals, orphan/tampered Execute handoffs, and
  oversized persisted agent evidence;
- cross-proposal rollback data loss, external-writer races, hard-link
  disclosure, unsafe persisted paths/timestamps, incomplete Git evidence,
  revision-history loss, and misleading approval UX;
- split-chunk secret leakage, incoherent/partial render source evidence,
  hidden Git index flags, ignored render inputs, source symlinks, orphaned
  process groups, non-cooperative fetch/browser promises, and late cleanup.

The final independent Task 10 review replayed ignored-input mutation, secret
non-persistence, symlink classes, excluded-directory bounds, late response
cancellation, listener balance, relational Git evidence, and identifier
grammar. It returned READY with no remaining finding.

## Debt and remaining risks

- The plan-mandated `"packageManager": "pnpm@10"` shorthand still emits the
  previously accepted non-exact-version warning under pnpm 11.
- A process crash while holding an approval/execution claim leaves the workflow
  safely fail-closed. v0.1 has no automatic stale-claim recovery UI; deleting a
  claim automatically could weaken approval uniqueness.
- Safe Mode has durable reconciliation evidence for detected indeterminate
  outcomes, but a general hard-crash transaction journal is outside Task 9.
- Render evidence intentionally refuses projects above its complete-evidence
  bounds: 512 eligible files, 64 MiB total, or 16 MiB per file. It never turns
  partial evidence into a freshness claim.
- The structured dev-command allowlist covers detected pnpm/yarn/npm web
  commands, not arbitrary custom shell commands. Unsupported projects remain
  `NEEDS_CONFIGURATION` pending an approved configuration workflow.
- The generic session-transition helper does not intrinsically freeze every
  reference identity field. Task 7's final persistence boundary validates the
  identity, but a future shared lifecycle hardening pass could centralize it.
- The local-first v0.1 boundary continues to treat independently running
  same-UID processes as trusted except where explicit transaction ownership
  detects interference. Stronger isolation would require native directory-
  relative filesystem capabilities or an architecture change.
- Visual comparison, deterministic visual PASS/FAIL, and stop criteria remain
  Task 11. Release-level governance remains Tasks 12–16.
- The live Codex SDK smoke is intentionally scheduled for Task 16 and remains
  `NOT VERIFIED`; injected SDK contract tests pass.

## Visual evidence

Task 7:

- `task-7-references.png`
- `task-7-learn-result.png`
- `task-7-reports.png`
- `task-7-mobile-learn.png`
- `task-7-mobile-references.png`

Task 8:

- `task-8-evolve-results.png`
- `task-8-mobile-evolve-results.png`
- `task-8-execute-handoff.png`
- `task-8-mobile-execute-handoff.png`

Task 9:

- `task-9-safe-proposal.png`
- `task-9-mobile-safe-proposal.png`
- `task-9-mobile-approval-gate.png`
- `task-9-mobile-approval-actions.png`
- `task-9-safe-mutation-evidence.png`
- `task-9-mobile-mutation-evidence.png`

The visual reviews found zero horizontal overflow at desktop and 390px mobile,
truthful action-specific busy states, intact approval gates, and the approved
calm technical visual direction. Task 10 has no new Studio UI; its disposable
fixture render is verified structurally and semantically by E2E rather than
presented as product-design evidence.

## Recommendation

Approve Phase 2 and proceed to Phase 3 (Task 11). Task 11 should consume the
fresh Task 10 artifact, establish deterministic visual findings and stop
criteria before agent prose, preserve Safe Mode and protected-path policy, and
require a fresh final render before any visual PASS.
