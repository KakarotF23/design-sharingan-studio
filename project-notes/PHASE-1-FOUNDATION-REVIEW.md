# Phase 1 Review — Foundation

**Status:** `PHASE PASS WITH DEBT`

**Accepted through:** `d4706ff` on `codex/design-sharingan-studio-v0-1`

Phase 1 implemented and independently reviewed Tasks 1–6 in dependency order:

1. pnpm/Turbo/Next/TypeScript/Vitest/Playwright bootstrap;
2. shared domain contracts, state machines, and autonomy policy;
3. guarded local workspace persistence;
4. local and GitHub project adapters;
5. the shared official Codex SDK runtime wrapper;
6. project intake and the typed Studio shell/routes.

## Verification evidence

Fresh verification after the final Task 6 semantic change:

```text
CI=true pnpm install --frozen-lockfile  PASS
CI=true pnpm test                     PASS — 82 passed, 1 planned live SDK smoke skipped
CI=true pnpm typecheck                PASS — 5/5 workspace typechecks
CI=true pnpm build                    PASS — Next.js 16.3.2 production build
CI=true pnpm e2e                      PASS — 9/9 Playwright tests
git diff --check                      PASS
```

Task 6 also passed its focused intake suite 8/8. Its final independent review
reported no Blocker, Important, or Minor findings.

## Checkpoint commits

- `8da8454` — verified kickoff baseline
- `33ce065`, `64572d9` — Task 1 bootstrap and review fix
- `44518f1`, `49073d2` — Task 2 domain and policy hardening
- `0415dd9`, `f2875da` — Task 3 persistence and boundary hardening
- `f8151fd` through `d696da9` — Task 4 adapters and five review rounds
- `adb51d7`, `2cee656`, `67eb34c` — Task 5 SDK runtime and redaction fixes
- `83ac684` — phase-based development policy
- `4dbd200`, `ce6e82e`, `d4706ff` — Task 6 Studio shell and two review rounds

## Important decisions and deviations

- The repository started empty with an unborn `main`, so work used a dedicated
  `codex/` branch in place rather than a linked worktree without a committed
  base.
- Minimal package manifests/configuration were added at each package's first
  task where the plan required package-level test/typecheck commands but did
  not list those support files.
- The Task 2 transient `APPROVED` authorization state was retained because the
  plan explicitly requires `APPROVED → EDITING`; this strengthens the human
  mutation gate.
- GitHub imports use a no-checkout fetch plus isolated, fail-closed
  materialization so repository hooks and configured filters cannot execute.
- The official `@openai/codex-sdk` is pinned at `0.149.0`; all runtime calls
  pass through the shared wrapper and recursively redact secrets.
- Studio project routes use server-owned opaque locators and fresh server-side
  detection. The client never receives a local root path or GitHub token.

## Debt and remaining risks

- The plan-mandated `"packageManager": "pnpm@10"` shorthand emits a warning
  under pnpm 11 because it is not an exact version. It was preserved verbatim.
- First-time concurrent creation of the same missing fixed workspace directory
  may fail closed with `EEXIST`; direct malformed-metadata regression coverage
  can also be expanded.
- Git branch names could receive earlier Git ref-format validation, and the
  project detector may merit decomposition after v0.1 if it grows further.
- The v0.1 trust boundary treats independently running same-UID processes as
  trusted. Defending pathname persistence against an already-hostile same-user
  process would require native directory-relative filesystem capabilities, OS
  isolation, or an architecture revision.
- The live Codex SDK smoke is intentionally scheduled for Task 16 and remains
  `NOT VERIFIED` at this phase; the injected SDK contract suite passes.

## Visual evidence

- `task-6-landing.png` — landing/source selection
- `task-6-intake.png` — local project intake
- `task-6-shell.png` — desktop Studio shell
- `task-6-mobile.png` — narrow viewport intake

Artifacts are stored under the Codex visualization workspace for this task.
The visual review found the approved premium, calm, technical direction intact:
restrained obsidian/graphite surfaces, bone typography, selective crimson, no
generic neon/glass dashboard treatment, and no mobile horizontal overflow.

## Recommendation

Approve Phase 1 and proceed to Phase 2 (Tasks 7–10). Task 7 should begin with
the structured-output SCAN test and keep V1 strictly read-only with explicit
KEEP / REJECT / ADAPT / INVENT output.
