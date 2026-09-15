# Design Sharingan Studio v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Design Sharingan Studio that can analyze visual references, propose UX directions, safely edit existing web projects, run render/compare/fix loops, and maintain product-level design governance.

**Architecture:** A pnpm/Turborepo monorepo with a Next.js Studio UI and isolated Node packages for project adapters, Codex agent runtime, V1/V2/V3 engines, approval policy, rendering, visual findings, and governance. All project mutations are scoped to an active workspace and all completion claims are backed by fresh evidence.

**Tech Stack:** TypeScript, pnpm, Turborepo, Next.js, React, Tailwind CSS, Vitest, Playwright, Zod, `@openai/codex-sdk`, Node.js filesystem/process APIs.

**Spec:** `docs/superpowers/specs/2026-08-24-design-sharingan-studio-v0.1-design.md`

## Global Constraints

- Local-first architecture.
- Project sources: Local Folder + GitHub Repository.
- v0.1 visual automation supports web projects only.
- V1 never mutates target-project code.
- Safe Mode requires human approval for every new mutation proposal.
- Mangekyō Mode may auto-apply only policy-approved visual changes.
- Autonomous dependency installation, navigation changes, persistent data-model changes, file deletion, and protected-path mutation are disabled by default.
- A visual PASS requires fresh rendered evidence after the final UI change.
- A whole-product PASS may cover only the screens/states actually inspected.
- Reference similarity never outranks UX integrity, product consistency, or accessibility.
- `design-governance/` is human-readable product knowledge; `.design-sharingan/` is machine/runtime state.
- Use tests-first for all feature and behavior changes.
- Make small commits after each independently passing task.

---

# File Map

The final v0.1 repository should contain these primary implementation units:

```text
design-sharingan-studio/
├── apps/
│   └── studio/
│       ├── app/
│       │   ├── page.tsx
│       │   ├── projects/page.tsx
│       │   ├── projects/[projectId]/layout.tsx
│       │   ├── projects/[projectId]/overview/page.tsx
│       │   ├── projects/[projectId]/references/page.tsx
│       │   ├── projects/[projectId]/learn/page.tsx
│       │   ├── projects/[projectId]/execute/page.tsx
│       │   ├── projects/[projectId]/govern/page.tsx
│       │   ├── projects/[projectId]/reports/page.tsx
│       │   └── projects/[projectId]/settings/page.tsx
│       ├── features/
│       │   ├── projects/
│       │   ├── references/
│       │   ├── learn/
│       │   ├── execute/
│       │   └── govern/
│       └── lib/
├── packages/
│   ├── core/
│   ├── agent-runtime/
│   ├── project-adapters/
│   ├── sharingan-engine/
│   ├── approval-engine/
│   ├── render-engine/
│   ├── visual-engine/
│   ├── mangekyo-engine/
│   ├── governance/
│   ├── eternal-engine/
│   └── ui/
├── skills/
│   ├── design-sharingan/
│   ├── mangekyo-sharingan/
│   └── eternal-sharingan/
├── tests/
│   ├── fixtures/
│   └── e2e/
├── docs/
│   └── superpowers/
│       ├── specs/
│       └── plans/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

`packages/agent-runtime/` is an implementation-level refinement of the approved Node Agent Layer. It centralizes the official Codex SDK integration so the three design engines do not duplicate thread/image/schema/working-directory behavior.

---

# Task 1: Bootstrap the Monorepo and Test Harness

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `apps/studio/package.json`
- Create: `apps/studio/next.config.ts`
- Create: `apps/studio/tsconfig.json`
- Create: `apps/studio/app/layout.tsx`
- Create: `apps/studio/app/globals.css`
- Create: `apps/studio/app/page.tsx`
- Create: `tests/e2e/playwright.config.ts`
- Create: `tests/e2e/smoke.spec.ts`
- Copy spec to: `docs/superpowers/specs/2026-08-24-design-sharingan-studio-v0.1-design.md`

**Interfaces:**
- Produces: a runnable Next.js app at `apps/studio`.
- Produces: root commands `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm e2e`.

- [ ] **Step 1: Write the failing E2E smoke test**

Create `tests/e2e/smoke.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("Studio landing page exposes both project entry paths", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Design Sharingan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Local Project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import GitHub Repo" })).toBeVisible();
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm exec playwright test tests/e2e/smoke.spec.ts
```

Expected: FAIL because the app/workspace does not exist yet.

- [ ] **Step 3: Create the workspace configuration**

Root `package.json`:

```json
{
  "name": "design-sharingan-studio",
  "private": true,
  "packageManager": "pnpm@10",
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "test": "turbo test",
    "typecheck": "turbo typecheck",
    "e2e": "playwright test -c tests/e2e/playwright.config.ts"
  },
  "devDependencies": {
    "@playwright/test": "latest",
    "turbo": "latest",
    "typescript": "latest"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "dev": { "cache": false, "persistent": true },
    "build": { "dependsOn": ["^build"], "outputs": [".next/**", "dist/**"] },
    "test": { "dependsOn": ["^test"] },
    "typecheck": { "dependsOn": ["^typecheck"] }
  }
}
```

- [ ] **Step 4: Create the minimal Studio landing page**

`apps/studio/app/page.tsx`:

```tsx
export default function HomePage() {
  return (
    <main>
      <h1>Design Sharingan</h1>
      <p>See the design. Understand the logic. Evolve the product.</p>
      <button type="button">Open Local Project</button>
      <button type="button">Import GitHub Repo</button>
    </main>
  );
}
```

- [ ] **Step 5: Install dependencies and run baseline checks**

Run:

```bash
pnpm install
pnpm --filter studio typecheck
pnpm --filter studio build
pnpm e2e
```

Expected: all commands exit 0 and smoke test passes.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "chore: bootstrap design sharingan studio"
```

---

# Task 2: Implement Core Domain Contracts and State Machines

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/domain.ts`
- Create: `packages/core/src/states.ts`
- Create: `packages/core/src/policy.ts`
- Create: `packages/core/src/__tests__/states.test.ts`
- Create: `packages/core/src/__tests__/policy.test.ts`

**Interfaces:**
- Produces: all shared domain types defined by the approved spec.
- Produces: `canTransitionProject`, `canTransitionLearnSession`, `canTransitionSafeExecution`, `canTransitionMangekyo`.
- Produces: `DEFAULT_AUTONOMY_POLICY` and `evaluateAutonomyPolicy()`.

- [ ] **Step 1: Write failing state-transition tests**

`packages/core/src/__tests__/states.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  canTransitionProject,
  canTransitionSafeExecution,
  canTransitionMangekyo
} from "../states";

describe("workflow state machines", () => {
  it("allows project scan to require configuration", () => {
    expect(canTransitionProject("SCANNING", "NEEDS_CONFIGURATION")).toBe(true);
  });

  it("prevents Safe Mode from editing before approval", () => {
    expect(canTransitionSafeExecution("WAITING_APPROVAL", "EDITING")).toBe(false);
    expect(canTransitionSafeExecution("APPROVED", "EDITING")).toBe(true);
  });

  it("routes Mangekyo policy escalation through HUMAN_GATE", () => {
    expect(canTransitionMangekyo("DECIDING", "HUMAN_GATE")).toBe(true);
    expect(canTransitionMangekyo("DECIDING", "EDITING")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm --filter @design-sharingan/core test
```

Expected: FAIL because state helpers are undefined.

- [ ] **Step 3: Implement explicit transition tables**

`packages/core/src/states.ts` should implement transition sets, for example:

```ts
const safeTransitions = {
  IDLE: ["PREPARING"],
  PREPARING: ["PROPOSING", "FAILED"],
  PROPOSING: ["WAITING_APPROVAL"],
  WAITING_APPROVAL: ["APPROVED", "REVISING", "REJECTED"],
  APPROVED: ["EDITING"],
  REVISING: ["PROPOSING"],
  EDITING: ["RUNNING", "FAILED"],
  RUNNING: ["CAPTURING", "FAILED"],
  CAPTURING: ["VERIFYING", "FAILED"],
  VERIFYING: ["COMPLETE", "PROPOSING", "FAILED"],
  COMPLETE: [],
  REJECTED: [],
  FAILED: []
} as const;
```

Expose predicate helpers instead of letting UI infer transitions.

- [ ] **Step 4: Write failing autonomy policy tests**

`packages/core/src/__tests__/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_AUTONOMY_POLICY, evaluateAutonomyPolicy } from "../policy";

describe("autonomy policy", () => {
  it("allows style-only edits", () => {
    expect(
      evaluateAutonomyPolicy(DEFAULT_AUTONOMY_POLICY, {
        kind: "STYLE_CHANGE",
        files: ["src/Home.tsx"]
      }).decision
    ).toBe("ALLOW");
  });

  it("escalates navigation changes", () => {
    expect(
      evaluateAutonomyPolicy(DEFAULT_AUTONOMY_POLICY, {
        kind: "NAVIGATION_CHANGE",
        files: ["src/navigation.ts"]
      }).decision
    ).toBe("HUMAN_GATE");
  });

  it("blocks protected paths", () => {
    const policy = {
      ...DEFAULT_AUTONOMY_POLICY,
      protectedPaths: ["src/auth/**"]
    };

    expect(
      evaluateAutonomyPolicy(policy, {
        kind: "STYLE_CHANGE",
        files: ["src/auth/Login.tsx"]
      }).decision
    ).toBe("HUMAN_GATE");
  });
});
```

- [ ] **Step 5: Implement policy contracts and domain schemas**

Create strongly typed unions for:
- `ProjectStatus`
- `ReferenceStatus`
- `LearnSessionStatus`
- `SafeExecutionStatus`
- `MangekyoStatus`
- `FindingSeverity`
- `FindingCategory`
- `ReleaseGateStatus`
- `DesignSessionType`

Implement all domain interfaces from the approved spec in `domain.ts`.

- [ ] **Step 6: Verify GREEN**

```bash
pnpm --filter @design-sharingan/core test
pnpm --filter @design-sharingan/core typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat: add core design workflow domain"
```

---

# Task 3: Build Workspace Persistence and Artifact Storage

**Files:**
- Create: `packages/project-adapters/src/workspace-store.ts`
- Create: `packages/project-adapters/src/path-policy.ts`
- Create: `packages/project-adapters/src/__tests__/workspace-store.test.ts`
- Create: `packages/project-adapters/src/__tests__/path-policy.test.ts`

**Interfaces:**
- Produces: `ensureDesignWorkspace(rootPath)`
- Produces: `saveProjectMetadata(project)`
- Produces: `saveReferenceArtifact(reference, bytes)`
- Produces: `saveSession(session)`
- Produces: `saveRenderArtifact(metadata, bytes)`
- Produces: `assertPathInsideWorkspace(rootPath, candidatePath)`

- [ ] **Step 1: Write failing filesystem-boundary tests**

```ts
it("rejects writes outside the active project", () => {
  expect(() =>
    assertPathInsideWorkspace("/tmp/project", "/tmp/other/secret.txt")
  ).toThrow(/outside active project/i);
});
```

Add a second test verifying:
- `.design-sharingan/` is created;
- `design-governance/` is not automatically treated as approved truth;
- JSON writes use atomic temp-file rename.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @design-sharingan/project-adapters test
```

- [ ] **Step 3: Implement workspace directories**

`ensureDesignWorkspace()` creates:

```text
.design-sharingan/
  project.json
  references/
  sessions/
  renders/
  cache/
```

Do not create approved governance content here.

- [ ] **Step 4: Implement path policy**

Resolve real paths before mutation. Reject any candidate path whose resolved form is outside the active project workspace.

- [ ] **Step 5: Implement JSON persistence**

Use stable JSON serialization with two-space indentation and atomic write replacement.

- [ ] **Step 6: Verify GREEN**

```bash
pnpm --filter @design-sharingan/project-adapters test
```

- [ ] **Step 7: Commit**

```bash
git add packages/project-adapters
git commit -m "feat: add local workspace persistence"
```

---

# Task 4: Implement Local and GitHub Project Adapters

**Files:**
- Create: `packages/project-adapters/src/index.ts`
- Create: `packages/project-adapters/src/types.ts`
- Create: `packages/project-adapters/src/detect-project.ts`
- Create: `packages/project-adapters/src/local-project-adapter.ts`
- Create: `packages/project-adapters/src/github-project-adapter.ts`
- Create: `packages/project-adapters/src/git.ts`
- Create: `packages/project-adapters/src/__tests__/detect-project.test.ts`
- Create: `packages/project-adapters/src/__tests__/local-project-adapter.test.ts`
- Create: `packages/project-adapters/src/__tests__/github-project-adapter.test.ts`
- Create fixture: `tests/fixtures/next-basic/`

**Interfaces:**
- Produces: `ProjectWorkspace`.
- Consumes: active folder or GitHub repo URL + branch + optional token.
- Produces capabilities: `canReadFiles`, `canWriteFiles`, `canRun`, `canRender`, `canCapture`, `canUseGit`, `canAudit`.

- [ ] **Step 1: Write failing Next.js detection test**

Fixture `tests/fixtures/next-basic/package.json` contains:

```json
{
  "name": "next-basic",
  "scripts": { "dev": "next dev" },
  "dependencies": { "next": "latest", "react": "latest", "react-dom": "latest" }
}
```

Test:

```ts
it("detects a runnable Next.js project", async () => {
  const result = await detectProject(fixturePath("next-basic"));
  expect(result.framework).toBe("nextjs");
  expect(result.devCommand).toBe("pnpm dev");
  expect(result.capabilities.canRun).toBe(true);
  expect(result.capabilities.canRender).toBe(true);
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @design-sharingan/project-adapters test
```

- [ ] **Step 3: Implement project detection**

Detection order:
1. `package.json`
2. lockfiles (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`)
3. Next/Vite/React signatures
4. scripts
5. route directories
6. Git availability

Do not execute arbitrary project scripts during detection.

- [ ] **Step 4: Write failing LocalProjectAdapter test**

Verify it:
- returns same root path;
- creates `.design-sharingan/project.json`;
- sets `sourceType: "LOCAL"`.

- [ ] **Step 5: Implement LocalProjectAdapter**

Return `NEEDS_CONFIGURATION` instead of guessing if no safe dev command or render target can be detected.

- [ ] **Step 6: Write failing GitHub adapter test with injected Git runner**

Do not use the network in unit tests. Inject a fake `GitRunner` and assert:
- clone command receives repo URL and branch;
- token is never included in persisted project metadata;
- cloned workspace is passed through `detectProject()`.

- [ ] **Step 7: Implement GitHubProjectAdapter**

For private repositories, pass credentials through environment/credential helper inputs, never through logs or project files.

- [ ] **Step 8: Verify GREEN**

```bash
pnpm --filter @design-sharingan/project-adapters test
```

- [ ] **Step 9: Commit**

```bash
git add packages/project-adapters tests/fixtures/next-basic
git commit -m "feat: add local and github project adapters"
```

---

# Task 5: Add the Shared Codex Agent Runtime

**Files:**
- Create: `packages/agent-runtime/package.json`
- Create: `packages/agent-runtime/src/index.ts`
- Create: `packages/agent-runtime/src/types.ts`
- Create: `packages/agent-runtime/src/codex-agent.ts`
- Create: `packages/agent-runtime/src/__tests__/codex-agent.test.ts`

**Interfaces:**
- Consumes: prompt, working directory, images, output schema, optional existing thread id.
- Produces: typed result `{ threadId, finalResponse, structured, items }`.
- Uses: official `@openai/codex-sdk`.

- [ ] **Step 1: Write a failing provider-contract test**

Use an injected fake SDK client:

```ts
it("passes working directory, images, and output schema to Codex", async () => {
  const result = await agent.run({
    workingDirectory: "/project",
    prompt: "Analyze this reference",
    images: ["/project/.design-sharingan/references/ref.png"],
    outputSchema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false
    }
  });

  expect(fakeThreadOptions.workingDirectory).toBe("/project");
  expect(fakeRunInput.images).toEqual([
    "/project/.design-sharingan/references/ref.png"
  ]);
  expect(result.structured).toEqual({ summary: "ok" });
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @design-sharingan/agent-runtime test
```

- [ ] **Step 3: Implement the wrapper**

Use:

```ts
import { Codex } from "@openai/codex-sdk";
```

Start a thread with the active project as working directory. Resume when a stored thread id exists.

The wrapper must:
- accept image paths;
- accept JSON Schema output;
- return thread id;
- expose final response and event items;
- redact configured secret environment keys before surfacing logs.

- [ ] **Step 4: Add a local integration test guarded by environment**

Create an integration test skipped unless `RUN_CODEX_INTEGRATION=1`. It should ask Codex for a two-field structured response and verify schema adherence.

- [ ] **Step 5: Verify GREEN**

```bash
pnpm --filter @design-sharingan/agent-runtime test
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent-runtime
git commit -m "feat: add shared codex agent runtime"
```

---

# Task 6: Build the Studio Shell, Routes, and Project Intake UI

**Files:**
- Create: `packages/ui/src/*`
- Create: `apps/studio/app/projects/page.tsx`
- Create: `apps/studio/app/projects/[projectId]/layout.tsx`
- Create: route pages for overview/references/learn/execute/govern/reports/settings
- Create: `apps/studio/features/projects/project-intake.tsx`
- Create: `apps/studio/features/projects/project-detection-card.tsx`
- Create: `apps/studio/features/projects/project-status.tsx`
- Create: `tests/e2e/project-intake.spec.ts`

**Interfaces:**
- Consumes: project adapter service.
- Produces: navigation into `/projects/:projectId/overview`.

- [ ] **Step 1: Write failing project-intake E2E test**

Test both buttons on landing. For Local Project, test the supported v0.1 browser interaction path: paste/select a filesystem path through the local Node endpoint rather than claiming the browser itself can arbitrarily browse unrestricted local directories.

Expected UI after scan:
- framework;
- package manager;
- dev command;
- capability status;
- `Open Studio` button.

- [ ] **Step 2: Run RED**

```bash
pnpm e2e tests/e2e/project-intake.spec.ts
```

- [ ] **Step 3: Implement StudioShell**

Create reusable:
- Sidebar
- ContextPanel
- ActivityPanel
- WorkspaceHeader
- StatusBadge
- ModeSwitcher

Keep visual styling restrained: dark neutral/ink surface is allowed, but no generic neon/glass dashboard treatment.

- [ ] **Step 4: Implement route skeletons**

Each workspace must render its title and context placeholder from typed project state.

- [ ] **Step 5: Implement project intake server actions/endpoints**

Server-side code calls adapters. Browser never receives GitHub token after submission.

- [ ] **Step 6: Verify GREEN**

```bash
pnpm --filter studio typecheck
pnpm e2e tests/e2e/project-intake.spec.ts
```

- [ ] **Step 7: Commit**

```bash
git add apps/studio packages/ui tests/e2e/project-intake.spec.ts
git commit -m "feat: add studio shell and project intake"
```

---

# Task 7: Implement Reference Library and V1 SCAN

**Files:**
- Create: `packages/sharingan-engine/src/index.ts`
- Create: `packages/sharingan-engine/src/schemas.ts`
- Create: `packages/sharingan-engine/src/scan.ts`
- Create: `packages/sharingan-engine/src/prompts.ts`
- Create: `packages/sharingan-engine/src/__tests__/scan.test.ts`
- Create: `apps/studio/features/references/reference-uploader.tsx`
- Create: `apps/studio/features/references/reference-card.tsx`
- Create: `apps/studio/features/learn/krai-grid.tsx`
- Create: `apps/studio/features/learn/design-dna-view.tsx`
- Create: `tests/e2e/reference-scan.spec.ts`

**Interfaces:**
- Consumes: one `Reference`, project context, user notes.
- Produces: `DesignDNA` with KEEP/REJECT/ADAPT/INVENT.
- Must not mutate target project.

- [ ] **Step 1: Write failing structured-output test**

The V1 SCAN schema must require:

```ts
{
  hierarchy: string,
  layout: string,
  spacing: string,
  typography: string,
  colorLogic: string,
  componentGeometry: string,
  navigation: string,
  interaction: string,
  motion: string,
  density: string,
  emotionalTone: string,
  visualWeight: string,
  keep: string[],
  reject: string[],
  adapt: string[],
  invent: string[]
}
```

Test a fake Codex result and verify it becomes a persisted `DesignDNA`.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @design-sharingan/sharingan-engine test
```

- [ ] **Step 3: Implement SCAN prompt contract**

Prompt rules:
- analyze principle, not identity;
- do not imitate logo/artwork/brand;
- explicitly output KEEP/REJECT/ADAPT/INVENT;
- mention product fit where project context is available;
- no code mutation.

- [ ] **Step 4: Implement reference upload**

Persist image under:

```text
.design-sharingan/references/<referenceId>/
```

Store metadata in the reference record. Validate MIME type and size.

- [ ] **Step 5: Build the Learn SCAN UI**

Required controls:
- reference selector;
- likes/dislikes notes;
- “I don't know — analyze it for me” option;
- `Analyze` button;
- structured Design DNA view;
- KRAI grid.

- [ ] **Step 6: Write and run E2E**

E2E may use a fake agent provider mode (`DESIGN_SHARINGAN_FAKE_AGENT=1`) so CI does not call Codex.

Expected:
1. upload fixture image;
2. run scan;
3. see KEEP / REJECT / ADAPT / INVENT;
4. session appears in Reports.

- [ ] **Step 7: Verify GREEN**

```bash
pnpm --filter @design-sharingan/sharingan-engine test
pnpm e2e tests/e2e/reference-scan.spec.ts
```

- [ ] **Step 8: Commit**

```bash
git add packages/sharingan-engine apps/studio tests/e2e/reference-scan.spec.ts
git commit -m "feat: add reference library and sharingan scan"
```

---

# Task 8: Implement ASSIMILATE and Feature EVOLVE with Approval

**Files:**
- Create: `packages/sharingan-engine/src/assimilate.ts`
- Create: `packages/sharingan-engine/src/evolve.ts`
- Create: `packages/sharingan-engine/src/__tests__/evolve.test.ts`
- Create: `apps/studio/features/learn/ux-impact-map.tsx`
- Create: `apps/studio/features/learn/approach-card.tsx`
- Create: `apps/studio/features/learn/feature-brief-form.tsx`
- Create: `tests/e2e/feature-evolve.spec.ts`

**Interfaces:**
- Consumes: `FeatureBrief`, optional references, project summary, approved Genome if present.
- Produces: `UXImpact[]`, exactly 2 or 3 `DesignApproach` objects, one recommended.
- Produces: approval event before Execute session creation.

- [ ] **Step 1: Write failing approach-schema tests**

Assert:
- 2–3 approaches;
- exactly one recommended approach;
- each contains pros, cons, UX impact, complexity, genomeFit, likelyFiles;
- no implementation side effect.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @design-sharingan/sharingan-engine test
```

- [ ] **Step 3: Implement EVOLVE structured prompt**

The prompt must ask Codex to inspect project context read-only and identify:
- affected routes;
- affected components;
- navigation impact;
- UX risk;
- states;
- design-system implications.

It must explicitly forbid coding until approach approval.

- [ ] **Step 4: Implement ASSIMILATE**

Merge multiple reference analyses into a proposed direction. It may not update Design Genome directly.

- [ ] **Step 5: Implement approval persistence**

When user approves an approach:
- persist `Approval`;
- create a linked `SAFE_EXECUTION` or `MANGEKYO_LOOP` draft session;
- carry the approved approach id forward.

- [ ] **Step 6: Write and run E2E**

Expected flow:
1. create Feature Brief;
2. run EVOLVE;
3. see UX Impact;
4. see 2–3 approaches;
5. approve one;
6. Execute page receives approved direction.

- [ ] **Step 7: Verify GREEN**

```bash
pnpm --filter @design-sharingan/sharingan-engine test
pnpm e2e tests/e2e/feature-evolve.spec.ts
```

- [ ] **Step 8: Commit**

```bash
git add packages/sharingan-engine apps/studio tests/e2e/feature-evolve.spec.ts
git commit -m "feat: add feature ux evolution workflow"
```

---

# Task 9: Implement Safe Mode Change Proposals and Controlled Mutation

**Files:**
- Create: `packages/approval-engine/src/index.ts`
- Create: `packages/approval-engine/src/change-proposal.ts`
- Create: `packages/approval-engine/src/mutation-executor.ts`
- Create: `packages/approval-engine/src/__tests__/safe-mode.test.ts`
- Create: `apps/studio/features/execute/change-proposal-view.tsx`
- Create: `apps/studio/features/execute/approval-actions.tsx`
- Create: `tests/e2e/safe-mode.spec.ts`

**Interfaces:**
- Consumes: approved `DesignApproach`.
- Produces: `ChangeProposal`.
- Mutation executor requires an `APPROVED` approval referencing the same proposal id.

- [ ] **Step 1: Write the failing mutation-gate test**

```ts
it("refuses mutation without matching approval", async () => {
  await expect(
    executor.apply({
      proposal,
      approval: undefined
    })
  ).rejects.toThrow(/explicit approval/i);
});
```

Add tests for:
- rejected proposal;
- stale approval for different proposal id;
- path outside workspace;
- file deletion in Safe Mode only when specifically proposed and approved.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @design-sharingan/approval-engine test
```

- [ ] **Step 3: Implement proposal generation via Codex**

Ask Codex for a structured proposal first:
- files to create/modify/delete;
- components/screens affected;
- reason;
- risk;
- UX impact;
- visual impact.

Do not ask Codex to mutate yet.

- [ ] **Step 4: Implement controlled mutation turn**

After approval, continue the same Codex thread with:
- approved proposal;
- active working directory;
- explicit instruction to mutate only listed/approved scope.

- [ ] **Step 5: Capture Git before/after metadata**

If Git exists:
- record current branch;
- record porcelain status before;
- record diff after;
- surface in Activity/Git panel.

Do not auto-commit target-project changes in v0.1.

- [ ] **Step 6: Build Safe Mode UI**

Show:
- proposed files;
- screen/component impact;
- risk;
- `Approve & Execute`;
- `Request Revision`;
- `Reject`.

- [ ] **Step 7: Write and run E2E**

Fake agent proposes a harmless fixture change. Assert fixture content remains unchanged before approval and changes only after approval.

- [ ] **Step 8: Verify GREEN**

```bash
pnpm --filter @design-sharingan/approval-engine test
pnpm e2e tests/e2e/safe-mode.spec.ts
```

- [ ] **Step 9: Commit**

```bash
git add packages/approval-engine apps/studio tests/e2e/safe-mode.spec.ts
git commit -m "feat: add safe mode approval and mutation"
```

---

# Task 10: Implement the Web Render Engine and Evidence Model

**Files:**
- Create: `packages/render-engine/src/index.ts`
- Create: `packages/render-engine/src/dev-server.ts`
- Create: `packages/render-engine/src/capture.ts`
- Create: `packages/render-engine/src/readiness.ts`
- Create: `packages/render-engine/src/__tests__/render-engine.test.ts`
- Create: `tests/fixtures/renderable-next/`
- Create: `tests/e2e/render-capture.spec.ts`

**Interfaces:**
- Consumes: `ProjectWorkspace`, route, viewport.
- Produces: `RenderArtifact` containing file path, route, viewport, timestamp, source revision metadata.

- [ ] **Step 1: Write failing dev-server lifecycle test**

Inject process runner. Assert:
- dev command starts in project root;
- readiness waits for configured URL;
- timeout produces explicit failure;
- server cleanup occurs on test completion.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @design-sharingan/render-engine test
```

- [ ] **Step 3: Implement dev server runner**

No shell string concatenation. Use executable + args where possible.

- [ ] **Step 4: Implement Playwright capture**

Capture:
- screenshot PNG;
- route;
- viewport;
- timestamp;
- Git revision/status if available;
- session/round id.

Persist to:

```text
.design-sharingan/renders/<sessionId>/<roundId>/<viewport>.png
```

- [ ] **Step 5: Add renderable fixture and E2E**

Start fixture, capture `/`, verify PNG exists and metadata points to it.

- [ ] **Step 6: Verify GREEN**

```bash
pnpm --filter @design-sharingan/render-engine test
pnpm e2e tests/e2e/render-capture.spec.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/render-engine tests/fixtures/renderable-next tests/e2e/render-capture.spec.ts
git commit -m "feat: add web render and screenshot evidence"
```

---

# Task 11: Implement Visual Findings and the Mangekyō Loop

**Files:**
- Create: `packages/visual-engine/src/index.ts`
- Create: `packages/visual-engine/src/schemas.ts`
- Create: `packages/visual-engine/src/analyze-render.ts`
- Create: `packages/visual-engine/src/__tests__/analyze-render.test.ts`
- Create: `packages/mangekyo-engine/src/index.ts`
- Create: `packages/mangekyo-engine/src/loop.ts`
- Create: `packages/mangekyo-engine/src/stop-criteria.ts`
- Create: `packages/mangekyo-engine/src/__tests__/loop.test.ts`
- Create: `packages/mangekyo-engine/src/__tests__/stop-criteria.test.ts`
- Create: `apps/studio/features/execute/visual-compare.tsx`
- Create: `apps/studio/features/execute/visual-round-timeline.tsx`
- Create: `apps/studio/features/execute/autonomy-boundary-card.tsx`
- Create: `tests/e2e/mangekyo-loop.spec.ts`

**Interfaces:**
- Visual engine consumes reference image(s), current render image, product context/Genome.
- Produces typed `VisualFinding[]`.
- Mangekyō loop consumes approved direction + autonomy policy + render target.
- Produces `VisualRound[]` and final status.

- [ ] **Step 1: Write failing stop-criteria tests**

```ts
it("stops when critical findings are zero and final evidence is fresh", () => {
  expect(
    evaluateStopCriteria({
      round: 3,
      maxRounds: 5,
      criticalCount: 0,
      importantCount: 1,
      importantThreshold: 2,
      uxRegressions: 0,
      genomeConflicts: 0,
      hasFreshFinalRender: true
    }).stop
  ).toBe(true);
});

it("never passes without fresh final render", () => {
  expect(
    evaluateStopCriteria({
      round: 3,
      maxRounds: 5,
      criticalCount: 0,
      importantCount: 0,
      importantThreshold: 2,
      uxRegressions: 0,
      genomeConflicts: 0,
      hasFreshFinalRender: false
    }).reason
  ).toMatch(/fresh render/i);
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @design-sharingan/mangekyo-engine test
```

- [ ] **Step 3: Implement visual-analysis schema**

Require findings with:
- severity;
- category;
- screen;
- description;
- evidence;
- reason;
- recommendedAction.

The prompt must say:
- inspect rendered output, not source code as substitute;
- prioritize hierarchy/UX/product fit;
- do not chase pixel similarity at UX expense.

- [ ] **Step 4: Implement loop coordinator**

Per round:
1. policy check;
2. apply approved autonomous change through Codex;
3. run project;
4. capture fresh render;
5. analyze render;
6. persist round;
7. evaluate stop criteria;
8. either complete, fix, or enter HUMAN_GATE.

- [ ] **Step 5: Implement HUMAN_GATE**

If policy evaluation returns escalation:
- persist gate reason;
- stop mutation;
- UI shows Reject / Approve Once / Expand Scope.

- [ ] **Step 6: Build Execute visual UI**

Required:
- Safe/Mangekyō switch;
- reference/current side-by-side;
- current round;
- findings by severity;
- activity status;
- human gate card;
- round history.

- [ ] **Step 7: E2E autonomous policy scenario**

Use fake agent:
- round 1 proposes style edit: allowed;
- round 2 proposes navigation change: HUMAN_GATE;
- verify no navigation mutation happens before explicit approval.

- [ ] **Step 8: Verify GREEN**

```bash
pnpm --filter @design-sharingan/visual-engine test
pnpm --filter @design-sharingan/mangekyo-engine test
pnpm e2e tests/e2e/mangekyo-loop.spec.ts
```

- [ ] **Step 9: Commit**

```bash
git add packages/visual-engine packages/mangekyo-engine apps/studio tests/e2e/mangekyo-loop.spec.ts
git commit -m "feat: add mangekyo visual refinement loop"
```

---

# Task 12: Implement Design Genome and Screen Registry

**Files:**
- Create: `packages/governance/src/index.ts`
- Create: `packages/governance/src/genome-store.ts`
- Create: `packages/governance/src/screen-registry.ts`
- Create: `packages/governance/src/decision-store.ts`
- Create: `packages/governance/src/templates.ts`
- Create: `packages/governance/src/__tests__/genome-store.test.ts`
- Create: `packages/eternal-engine/src/init-genome.ts`
- Create: `packages/eternal-engine/src/guard.ts`
- Create: `packages/eternal-engine/src/__tests__/guard.test.ts`
- Create: `apps/studio/features/govern/genome-view.tsx`
- Create: `apps/studio/features/govern/screen-registry.tsx`
- Create: `tests/e2e/genome-init.spec.ts`

**Interfaces:**
- Produces/reads `design-governance/DESIGN-GENOME.md`.
- Produces/reads `SCREEN-REGISTRY.md`, `DESIGN-DECISIONS.md`.
- Genome may be `DRAFT` or `APPROVED`.
- Guard output: INHERIT / EXTEND / DECIDE / REJECT / VERIFY.

- [ ] **Step 1: Write failing Genome authority test**

```ts
it("does not treat a draft genome as authoritative", async () => {
  const result = await guardFeature({
    genome: { status: "DRAFT", /* ... */ },
    featureBrief
  });

  expect(result.genomeAuthority).toBe("NON_AUTHORITATIVE");
});
```

- [ ] **Step 2: Write failing repeated-drift test**

A repeated pattern across three screens must not automatically modify Genome invariants.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @design-sharingan/governance test
pnpm --filter @design-sharingan/eternal-engine test
```

- [ ] **Step 4: Implement Markdown governance store**

Use machine-readable frontmatter or embedded JSON comment metadata for ids/status while keeping main content human-readable.

- [ ] **Step 5: Implement Genome initialization**

Codex reads project context and representative current evidence. Any uncertain rule must land in `unconfirmedRules[]`.

User approval changes status from `DRAFT` to `APPROVED`.

- [ ] **Step 6: Implement Guard**

Return structured:
- INHERIT
- EXTEND
- DECIDE
- REJECT
- VERIFY

- [ ] **Step 7: Build Govern Genome/Screen UI**

Allow:
- review draft rules;
- approve Genome;
- view screen family/inheritance;
- inspect intentional exceptions.

- [ ] **Step 8: E2E Genome initialization**

Assert:
1. generated Genome starts DRAFT;
2. unconfirmed section is visible when present;
3. approval changes status;
4. governance files are created.

- [ ] **Step 9: Verify GREEN**

```bash
pnpm --filter @design-sharingan/governance test
pnpm --filter @design-sharingan/eternal-engine test
pnpm e2e tests/e2e/genome-init.spec.ts
```

- [ ] **Step 10: Commit**

```bash
git add packages/governance packages/eternal-engine apps/studio tests/e2e/genome-init.spec.ts
git commit -m "feat: add design genome and screen governance"
```

---

# Task 13: Implement Drift Audit and Release Gate

**Files:**
- Create: `packages/eternal-engine/src/audit.ts`
- Create: `packages/eternal-engine/src/release-gate.ts`
- Create: `packages/eternal-engine/src/__tests__/audit.test.ts`
- Create: `packages/eternal-engine/src/__tests__/release-gate.test.ts`
- Create: `apps/studio/features/govern/drift-view.tsx`
- Create: `apps/studio/features/govern/release-gate-view.tsx`
- Create: `tests/e2e/drift-audit.spec.ts`
- Create: `tests/e2e/release-gate.spec.ts`

**Interfaces:**
- Audit consumes explicitly enumerated screen/state evidence.
- Produces `DriftFinding[]` + inspected/unavailable scope.
- Release gate produces `PASS | PASS_WITH_DEBT | NOT_VERIFIED | BLOCKED`.

- [ ] **Step 1: Write failing audit-scope test**

```ts
it("cannot call a one-screen audit a whole-app audit", async () => {
  const report = await runDriftAudit({
    requestedScope: "WHOLE_APP",
    evidence: [{ screen: "Home", status: "INSPECTED" }]
  });

  expect(report.overallStatus).toBe("NOT_VERIFIED");
  expect(report.unverifiedScope.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Write failing release-evidence test**

```ts
it("blocks PASS when final render evidence is stale", () => {
  const result = evaluateReleaseGate({
    navigation: "PASS",
    accessibility: "PASS",
    criticalDrift: "PASS",
    newDesignRules: "PASS",
    screenRegistration: "PASS",
    requiredStates: "PASS",
    freshRenders: "FAIL",
    decisions: "PASS",
    functionalVerification: "PASS"
  });

  expect(result.status).toBe("NOT_VERIFIED");
});
```

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @design-sharingan/eternal-engine test
```

- [ ] **Step 4: Implement audit**

Audit order:
1. UX/navigation;
2. accessibility/required states;
3. product identity/screen-family consistency;
4. components/tokens;
5. hierarchy;
6. motion;
7. polish.

Persist `DRIFT-REPORT.md`.

- [ ] **Step 5: Implement release gate**

Release gate is deterministic over collected checks. The agent may help gather evidence and explain findings, but status rules must be code-owned.

- [ ] **Step 6: Build Drift and Release UI**

Drift cards:
- severity;
- expected rule;
- observed evidence;
- why it matters;
- smallest coherent fix;
- send-to-Execute action.

Release checklist:
- check;
- status;
- evidence;
- last verified;
- blocking reason.

- [ ] **Step 7: Run E2E**

Cover:
- partial audit → NOT_VERIFIED;
- no critical drift but missing state → NOT_VERIFIED;
- documented non-blocking polish debt → PASS_WITH_DEBT;
- all checks satisfied → PASS.

- [ ] **Step 8: Verify GREEN**

```bash
pnpm --filter @design-sharingan/eternal-engine test
pnpm e2e tests/e2e/drift-audit.spec.ts tests/e2e/release-gate.spec.ts
```

- [ ] **Step 9: Commit**

```bash
git add packages/eternal-engine apps/studio tests/e2e
git commit -m "feat: add drift audit and design release gate"
```

---

# Task 14: Add Reports, Activity, Git Evidence, and Session History

**Files:**
- Create: `apps/studio/features/reports/session-list.tsx`
- Create: `apps/studio/features/reports/session-detail.tsx`
- Create: `apps/studio/features/activity/activity-panel.tsx`
- Create: `apps/studio/features/activity/git-panel.tsx`
- Create: `apps/studio/features/activity/render-panel.tsx`
- Create: `packages/core/src/activity.ts`
- Create: `packages/core/src/__tests__/activity.test.ts`
- Create: `tests/e2e/reports.spec.ts`

**Interfaces:**
- Every meaningful workflow emits typed activity events.
- Reports are a read-only projection of saved `DesignSession` records and artifacts.

- [ ] **Step 1: Write failing activity ordering test**

Activity events must retain session id, timestamp, category, message, and evidence reference.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @design-sharingan/core test
```

- [ ] **Step 3: Implement activity event model**

Categories:
- SYSTEM
- AGENT
- APPROVAL
- RENDER
- GIT
- GOVERNANCE

Messages should be concrete, e.g.:
- `Analyzing reference`
- `Waiting for approval`
- `Capturing /home`
- `Navigation change requires human decision`

Do not surface “Thinking…” as a workflow state.

- [ ] **Step 4: Implement Reports UI**

Session types, result, duration, evidence, files changed, approvals, visual rounds.

- [ ] **Step 5: E2E session history**

Run fake SCAN then Safe Mode session and verify both appear in Reports with linked artifacts.

- [ ] **Step 6: Verify GREEN**

```bash
pnpm --filter @design-sharingan/core test
pnpm e2e tests/e2e/reports.spec.ts
```

- [ ] **Step 7: Commit**

```bash
git add apps/studio packages/core tests/e2e/reports.spec.ts
git commit -m "feat: add activity evidence and reports"
```

---

# Task 15: Install the V1/V2/V3 Skill Pack Into the Repository

**Files:**
- Copy: `skills/design-sharingan/**`
- Copy: `skills/mangekyo-sharingan/**`
- Copy: `skills/eternal-sharingan/**`
- Create: `scripts/install-skills.sh`
- Create: `scripts/verify-skills.sh`
- Create: `tests/skills/skill-pack.test.ts`

**Interfaces:**
- Repository can install all three skills into `~/.agents/skills/`.
- Studio runtime does not depend on shell skill installation for core app behavior.

- [ ] **Step 1: Write failing static skill-pack test**

Verify each skill contains:
- `SKILL.md`;
- correct frontmatter name;
- supported invocation names.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/skills/skill-pack.test.ts
```

- [ ] **Step 3: Copy approved skill pack**

Use the previously produced V1/V2/V3 files as the source. Do not rewrite behavior during this task.

- [ ] **Step 4: Add install/verify scripts**

`install-skills.sh` installs:
- `design-sharingan`
- `mangekyo-sharingan`
- `eternal-sharingan`

to `~/.agents/skills/` by default.

- [ ] **Step 5: Verify GREEN**

```bash
pnpm vitest run tests/skills/skill-pack.test.ts
bash scripts/verify-skills.sh --source ./skills
```

- [ ] **Step 6: Commit**

```bash
git add skills scripts tests/skills
git commit -m "feat: bundle design sharingan codex skills"
```

---

# Task 16: Full Acceptance Verification and v0.1 Handoff

**Files:**
- Create: `docs/verification/v0.1-acceptance.md`
- Create: `tests/e2e/full-loop.spec.ts`
- Modify: root `README.md`
- Modify: package scripts as needed

**Interfaces:**
- Verifies all seven acceptance flows from the spec.
- Produces evidence-backed launch instructions.

- [ ] **Step 1: Write the full-loop E2E test first**

In fake-agent mode:

1. open fixture project;
2. upload reference;
3. SCAN;
4. EVOLVE feature;
5. approve approach;
6. Safe Mode proposal;
7. approve mutation;
8. render;
9. run one Mangekyō refinement;
10. initialize/approve Genome;
11. run drift audit;
12. run release gate.

The final assertion must verify all artifacts exist:
- session records;
- reference image;
- render image;
- approved Genome;
- Screen Registry;
- Drift Report;
- release result.

- [ ] **Step 2: Run RED**

```bash
pnpm e2e tests/e2e/full-loop.spec.ts
```

Expected: fail until all integration gaps are connected.

- [ ] **Step 3: Fix only integration gaps**

Do not introduce new product scope. Connect existing packages through the Studio server layer.

- [ ] **Step 4: Run full verification**

Run fresh:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm e2e
```

Expected:
- test suites: 0 failures;
- typecheck: exit 0;
- build: exit 0;
- E2E: exit 0.

- [ ] **Step 5: Run security/policy acceptance checks**

Manually or with automated pressure tests verify:
- no autonomous dependency install;
- no autonomous navigation mutation;
- no autonomous deletion;
- no whole-app PASS from partial evidence;
- no visual PASS without fresh final render;
- no Genome rewrite from repeated drift.

Document exact evidence in `docs/verification/v0.1-acceptance.md`.

- [ ] **Step 6: Run a real Codex SDK smoke session**

With an authenticated local Codex environment, run one reference SCAN against a sample screenshot. Record:
- SDK thread created;
- working directory correct;
- image attached;
- structured result parsed;
- no target-project mutation during V1.

Do not claim real-agent integration complete if this smoke run is not performed.

- [ ] **Step 7: Update README with local launch instructions**

Required:

```bash
pnpm install
pnpm dev
```

Document:
- project import;
- fake-agent mode for development;
- Codex runtime prerequisite for live agent mode;
- Playwright browser installation command;
- skill installation command.

- [ ] **Step 8: Re-run verification-before-completion**

Required sub-skill: `superpowers:verification-before-completion`.

Freshly run:
- tests;
- typecheck;
- build;
- E2E;
- acceptance checklist.

Only then describe v0.1 as complete.

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "release: verify design sharingan studio v0.1"
```

---

# Recommended Execution Order

The task dependency chain is:

```text
1 Bootstrap
  ↓
2 Core Domain
  ↓
3 Workspace Store
  ↓
4 Project Adapters
  ↓
5 Codex Agent Runtime
  ↓
6 Studio Shell
  ↓
7 V1 SCAN
  ↓
8 ASSIMILATE / EVOLVE
  ↓
9 Safe Mode
  ↓
10 Render Engine
  ↓
11 Mangekyō Loop
  ↓
12 Genome / Registry
  ↓
13 Drift / Release
  ↓
14 Reports / Activity
  ↓
15 Skill Pack
  ↓
16 Full Verification
```

Tasks 12–14 may be partially parallelized only after Tasks 1–11 have stable interfaces.

---

# Implementation Guardrails for Codex

When executing this plan:

- Read the approved spec before every major phase.
- Do not collapse package boundaries for convenience.
- Do not add cloud auth, billing, teams, native mobile automation, or Figma integration.
- Do not replace structured workflow state with ad hoc chat-only state.
- Do not allow the Studio UI to call arbitrary filesystem/process operations directly from React components.
- Do not use source-code inspection as a substitute for rendered UI evidence.
- Do not let agent prose determine release status when deterministic gate logic can decide it.
- Do not silently expand Mangekyō autonomy.
- Do not auto-commit target-project changes.
- Do not make the Sharingan visual theme interfere with professional usability.

---

# Execution Handoff

Plan complete. The recommended execution mode is:

**1. Subagent-Driven (recommended)**  
Use `superpowers:subagent-driven-development`. Dispatch a fresh implementer for each task, then perform spec-compliance and code-quality review before accepting the task.

**2. Inline Execution**  
Use `superpowers:executing-plans`. Execute tasks in this session in batches with checkpoints.

For the first build, prefer **Subagent-Driven** because the repository has several clean package boundaries and independent review points.

## Phase-Based Autopilot Development Policy

This policy changes the Codex development workflow only; it does not alter the
approved product architecture, Safe Mode, Mangekyō autonomy limits, Human
Gate, approval engine, or other application-level safety boundaries.

Execute the dependency chain in four phases:

1. **Foundation** — Tasks 1–6
2. **Design Intelligence** — Tasks 7–10
3. **Mangekyō** — Task 11
4. **Eternal + Final Verification** — Tasks 12–16

Within the current approved phase, continue automatically after each verified
task. A normal transition requires no human confirmation, but every task must
still complete its documented RED → GREEN sequence, required verification,
spec-compliance review, code-quality review, and checkpoint commit.

Stop for human direction only when the work requires a material architecture
change, v0.1 scope expansion, an unplanned major dependency/service, a
destructive replacement of significant work, a new authentication/security or
sensitive-data decision, a material unresolved UX/product choice, resolution
of a material spec/plan contradiction, guessing after disciplined repeated
verification failure, or unavoidable platform permission.

At each phase boundary, stop with one consolidated report covering completed
tasks, tests, typecheck/build/E2E status, commits, important decisions,
deviations, technical debt, relevant renders, remaining risks, and the
recommendation to proceed. Classify it as `PHASE PASS`, `PHASE PASS WITH DEBT`,
`PHASE NOT VERIFIED`, or `PHASE BLOCKED`.
