# Task 16 Round 3 Governance Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` inline. The project policy prohibits delegating this remediation.

**Goal:** Make a post-Genome-approval render the only eligible source for the Flow F audit and ensure that a human, not a Mangekyō agent result, promotes an exact observational rule into signed governance evidence.

**Architecture:** Render-source capture continues to fingerprint every target file other than runtime state. Mangekyō results remain persisted observations. Genome initialization records those candidates as unconfirmed, and the explicit server-side Genome approval transaction validates one exact candidate against a current render/catalog relation before it writes the corresponding signed verified claim and approved Genome document atomically under the existing governance lock.

**Tech Stack:** TypeScript, Vitest, Playwright, signed local governance Markdown/JSON, Next.js server routes.

**Spec:** `docs/superpowers/specs/2026-08-24-design-sharingan-studio-v0.1-design.md`

## Global Constraints

- Treat `design-governance/` as human-readable target-project knowledge and possible runtime input; never exclude it from render freshness evidence.
- `.design-sharingan/` remains machine/runtime state only.
- Product-consistency agent output is observational and cannot sign a claim, confirm a Genome rule, or bypass an explicit local-user approval.
- A claim approval fails closed unless the exact draft rule ID/text/category, one route/state, one eligible authenticated render, matching source fingerprint, and unshared catalog evidence all agree inside the locked transaction.
- No whole-product release PASS may be inferred from the default state of a single route.

---

### Task 1: Restore complete render-source freshness

**Files:**
- Modify: `packages/render-engine/src/capture.ts`
- Test: `packages/render-engine/src/__tests__/render-engine.test.ts`

**Interfaces:** `captureWorkspaceSourceRevision(workspace)` must report a `design-governance/DESIGN-GENOME.md` change in its Git status and worktree fingerprint.

- [ ] **Step 1: Write the failing test**

```ts
it("includes design-governance documents in Git status and source fingerprints", async () => {
  const first = await captureWorkspaceSourceRevision(gitWorkspace);
  await writeFile(join(root, "design-governance", "DESIGN-GENOME.md"), "# Draft\n");
  const second = await captureWorkspaceSourceRevision(gitWorkspace);
  expect(second).toMatchObject({ kind: "GIT", status: "DIRTY" });
  expect(second.worktreeFingerprint).not.toBe(first.worktreeFingerprint);
});
```

- [ ] **Step 2: Run it to verify RED**

Run: `pnpm --filter @design-sharingan/render-engine exec vitest run src/__tests__/render-engine.test.ts --testNamePattern='design-governance documents'`

Expected: the current blanket exclusion keeps the status clean and the fingerprint unchanged.

- [ ] **Step 3: Implement the minimum production change**

Remove `design-governance` from unversioned exclusions, source pathspec exclusions, ignored pathspec exclusions, and rejected source paths. Leave the existing `.design-sharingan` protection unchanged.

- [ ] **Step 4: Run it to verify GREEN**

Run the command from Step 2 and then the complete render-engine test file.

### Task 2: Model human promotion as a bounded governance approval

**Files:**
- Modify: `packages/core/src/domain.ts`
- Modify: `packages/eternal-engine/src/init-genome.ts`
- Modify: `packages/eternal-engine/src/genome-service.ts`
- Modify: `packages/governance/src/templates.ts`
- Modify: `packages/governance/src/genome-store.ts`
- Test: `packages/eternal-engine/src/__tests__/init-genome.test.ts`
- Test: `packages/governance/src/__tests__/genome-store.test.ts`

**Interfaces:** Draft claim citations expose a stable exact rule ID and remain `UNCONFIRMED`. `approveGenome` accepts the draft revision/hash plus exactly one locally approved candidate reference, and returns an authoritative document only after it has signed the exact matching catalog render claim.

- [ ] **Step 1: Write failing contracts**

```ts
expect(draft.metadata.claimCitations).toContainEqual(expect.objectContaining({
  id: expectedRuleId,
  statement: rule,
  confidence: "UNCONFIRMED",
}));
await expect(approveGenome(root, "project-a", forgedInput)).rejects.toThrow(/rule|render|evidence|fresh/i);
const approved = await approveGenome(root, "project-a", exactInput);
expect((await readEvidenceCatalog(root, "project-a")).find(({ id }) => id === evidenceId))
  .toMatchObject({ verifiedClaims: [expect.objectContaining({ statement: rule })] });
```

- [ ] **Step 2: Run focused RED**

Run the Eternal initializer and governance-store tests by exact test name. Expected: the existing agent-originated claim is already confirmed, and approval accepts no exact rule/evidence relation.

- [ ] **Step 3: Implement the minimum authority path**

Give each citation a deterministic rule ID. Remove all agent-originated verified-claim emission. Preserve candidate text/evidence in the draft as `UNCONFIRMED`. Under the existing machine governance lock, validate a single candidate against the current draft citation, its exact render catalog record, its route/default state/render ID/source revision, and non-reuse. Promote only that claim into the signed catalog and approved Genome while recording local-user authority; reject every mismatch or stale/concurrent request.

- [ ] **Step 4: Run focused GREEN**

Run the exact tests plus the complete `@design-sharingan/eternal-engine` and `@design-sharingan/governance` suites.

### Task 3: Drive the explicit promotion and post-approval capture through Studio

**Files:**
- Modify: `apps/studio/features/govern/govern-server.ts`
- Modify: `apps/studio/app/projects/[projectId]/govern/approve/route.ts`
- Modify: `apps/studio/features/govern/genome-view.tsx`
- Modify: `tests/e2e/full-loop.spec.ts`
- Test: `tests/e2e/full-loop.spec.ts`

**Interfaces:** The projection exposes only server-derived approvable candidates. The approval request carries the selected exact candidate, not a caller-created claim. Full Flow F captures a fresh post-governance render before audit and proves the report evidence is both post-approval and catalog-bound.

- [ ] **Step 1: Write the failing browser flow**

```ts
expect(draft.genome.unconfirmedRules).toContain(rule);
await page.getByRole("button", { name: "Approve Genome" }).click();
const approvedRender = await captureFreshRenderThroughStudio(page);
expect(approvedRender.sourceRevision.worktreeFingerprint).not.toBe(preApprovalRender.sourceRevision.worktreeFingerprint);
expect(drift.value.inspectedScope).toEqual(["/#default"]);
expect(finding.evidenceIds).toEqual([postApprovalCatalogEntry.id]);
```

- [ ] **Step 2: Run focused RED**

Run: `pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/full-loop.spec.ts`

Expected: current flow has its only capture before governance writes and lacks an explicit candidate selection/promotion relation.

- [ ] **Step 3: Implement Studio wiring**

Expose immutable candidate projections from signed draft citations. Validate the route request envelope exactly, hand it to the governance service, and make the draft approval control send the server-derived candidate. Continue through the existing capture endpoint/path after approval; do not invent a direct filesystem/session write.

- [ ] **Step 4: Run focused GREEN**

Run the full-loop test, Playwright configuration test, and policy-pressure acceptance test.

### Task 4: Record exact acceptance evidence and verify the release checkpoint

**Files:**
- Modify: `docs/verification/v0.1-acceptance.md`
- Modify: `.superpowers/sdd/2026-08-24-design-sharingan-studio-v0.1-implementation-plan/task-16-report.md`

- [ ] **Step 1: Update human-readable evidence**

State that Flow F uses post-approval render evidence, that `D — Mangekyō Loop` and `E — Design Genome` are the exact names, and that partial states retain `NOT_VERIFIED`.

- [ ] **Step 2: Run final evidence commands**

Run: `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm e2e`, `pnpm acceptance`, `RUN_CODEX_INTEGRATION=1 pnpm exec vitest run tests/acceptance/live-codex-scan.test.ts`, and `git diff --check`.

- [ ] **Step 3: Commit only the reviewed changes**

Run `git add` with the modified authority, freshness, tests, and documentation files, inspect `git diff --cached --check`, then create a checkpoint commit.

## Self-review

- Freshness is covered by Task 1 and the post-approval browser capture in Task 3.
- Agent authority, forged/missing/stale/shared/concurrent approval relations are covered by Task 2.
- Exact Studio API/UI flow and partial-release behavior are covered by Task 3.
- Documentation, verification, and surgical package-lock preservation are covered by Task 4.
- No plan step changes autonomy policy, target mutation boundaries, or whole-product release semantics.
