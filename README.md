# Design Sharingan Studio

Local-first design intelligence for web projects:

```text
Reference → Design Intelligence → Human Decision → Code Change → Real Render → Visual Review → Product Governance
```

It learns design reasoning rather than cloning pixels. References are evidence, never commands; a release gate reports only what fresh, authenticated evidence supports.

## Launch locally

Requires a current Node.js runtime with Corepack and pnpm available.

```bash
pnpm install
pnpm dev
```

Open the local Studio URL printed by the development server. Choose **Open Local Project** and enter an absolute path to a web project, or choose **Import GitHub Repo** and provide a repository URL. The Studio keeps its runtime state in `.design-sharingan/` in that target project; human-readable product knowledge belongs in `design-governance/`.

## Agent modes

The normal local mode uses the authenticated Codex runtime. Sign in first if needed:

```bash
codex login
```

For deterministic development and end-to-end tests, use the fake provider instead:

```bash
DESIGN_SHARINGAN_FAKE_AGENT=1 pnpm dev
```

Fake mode is only for development and tests. It is not evidence that the live Codex integration is available.

## Rendering and skills

Install the Playwright browser once before running browser tests:

```bash
pnpm exec playwright install chromium
```

Install the bundled Design Sharingan skills, then start a new Codex session so they are discovered:

```bash
bash scripts/install-project-skills.sh
bash scripts/verify-kickoff-pack.sh
```

## Verification

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm e2e
pnpm acceptance
```

The final command runs the v0.1 policy-pressure checks. A live SDK smoke is deliberately opt-in and requires a local Codex login:

```bash
RUN_CODEX_INTEGRATION=1 pnpm exec vitest run tests/acceptance/live-codex-scan.test.ts
```

See [the v0.1 acceptance record](docs/verification/v0.1-acceptance.md) for the evidence and the intentionally fail-closed release-gate result used by the end-to-end fixture.
