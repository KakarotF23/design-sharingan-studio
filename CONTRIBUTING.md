# Contributing to Design Sharingan Studio

Design Sharingan Studio is an experimental local-first design tool. You do not need to agree with its current product premise to contribute; evidence that a workflow is unnecessary is useful too.

## Good ways to help

- Try the Studio on a disposable web project and report where the workflow helps or gets in the way.
- Simplify the user journey without weakening explicit approval and filesystem safety boundaries.
- Improve onboarding, error messages, documentation, screenshots, or demo material.
- Add focused tests for a bug or policy edge case.
- Propose an alternative product direction in a GitHub Discussion before a large rewrite.

## Development setup

Read `AGENTS.md` and the approved specification and implementation plan before changing architecture or policy behavior.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm e2e
```

Keep changes focused. Feature and bug-fix pull requests should include appropriate tests, and UI changes should include fresh render evidence where practical.

## Safety boundaries

Do not weaken Safe Mode, protected-path handling, explicit approvals, evidence freshness, or fail-closed release behavior without a clearly explained proposal and review.

## Reporting feedback

Please include:

1. What kind of project you tried.
2. What you expected to happen.
3. What actually happened.
4. What you would remove, change, or keep.

Never attach repositories, logs, screenshots, or runtime state containing secrets or private customer data.
