# AGENTS.md — Design Sharingan Studio

## Mission

Build **Design Sharingan Studio v0.1** exactly from the approved Product & Architecture Specification and Implementation Plan in this repository.

The product is a local-first design intelligence environment:

**Reference → Design Intelligence → Human Decision → Code Change → Real Render → Visual Review → Product Governance**

Do not turn this into a generic AI dashboard or a screenshot-cloning tool.

---

## Source of Truth

Read these before implementation:

1. `docs/superpowers/specs/2026-08-24-design-sharingan-studio-v0.1-design.md`
2. `docs/superpowers/plans/2026-08-24-design-sharingan-studio-v0.1-implementation-plan.md`

If code, comments, or assumptions conflict with the approved spec, the approved spec wins.

The implementation plan defines task order and test-first checkpoints.

---

## Required Skills / Process

Use the installed Superpowers workflow when available.

For implementation:
- use `superpowers:subagent-driven-development` as the preferred execution mode;
- use `superpowers:test-driven-development` for feature work;
- use `superpowers:systematic-debugging` for unexpected failures;
- use `superpowers:requesting-code-review` at major review points;
- use `superpowers:verification-before-completion` before any completion claim.

Project design skills bundled under `skills/`:
- `design-sharingan`
- `mangekyo-sharingan`
- `eternal-sharingan`

Do not redesign the approved architecture while executing the plan unless a real contradiction or blocker is discovered. If that happens, stop, explain the issue, and request a decision.

---

## Execution Rule

Start with **Task 1** in the implementation plan.

Complete tasks in dependency order unless the plan explicitly says work can be parallelized.

For every task:

1. Read the task completely.
2. Confirm files and interfaces.
3. Write the failing test first.
4. Run it and observe the expected failure.
5. Implement the smallest correct change.
6. Run task-level tests/typecheck.
7. Review against the approved spec.
8. Commit only after verification passes.
9. Move to the next task.

Do not skip RED → GREEN.

## Phase-Based Autopilot Development Policy

This policy governs Codex development workflow only. It does not remove or
weaken the product-level Safe Mode, Mangekyō autonomy policy, Human Gate,
approval engine, or any safety boundary in the approved specification.

Development phases are:

- Phase 1 — Foundation: Tasks 1–6
- Phase 2 — Design Intelligence: Tasks 7–10
- Phase 3 — Mangekyō: Task 11
- Phase 4 — Eternal + Final Verification: Tasks 12–16

Within an approved phase, continue autonomously from one task to the next in
dependency order. Do not wait for routine human approval between tasks. Every
task still requires RED → GREEN TDD, task-level verification, spec-compliance
and code-quality review, a verified checkpoint commit, and automatic
continuation to the next task in the same phase.

Stop for human direction only when a genuine decision is required: a material
architecture change; v0.1 scope expansion; a major new dependency or external
service not implied by the plan; destructive replacement of significant work;
a new authentication, secrets, security, permissions, or sensitive-data
decision; an unresolved material UX/product choice; a material spec/plan
contradiction; repeated verification failure that would require guessing or
architectural deviation; or an unavoidable platform permission.

At the end of each phase, stop and provide one consolidated review containing
completed tasks, commands and verification evidence, build/typecheck/E2E
status, commits, important decisions, deviations, debt, relevant renders,
remaining risks, and a recommendation. Classify the phase as `PHASE PASS`,
`PHASE PASS WITH DEBT`, `PHASE NOT VERIFIED`, or `PHASE BLOCKED`.

---

## Architecture Boundaries

Keep these responsibilities separate:

```text
apps/studio                 GUI / routing / user interaction

packages/core               shared domain contracts + state machines
packages/agent-runtime      official Codex SDK wrapper
packages/project-adapters   local/GitHub workspace adapters
packages/sharingan-engine   V1 design intelligence
packages/approval-engine    Safe/Mangekyō mutation policy
packages/render-engine      dev server + Playwright rendering
packages/visual-engine      rendered visual analysis
packages/mangekyo-engine    V2 autonomous visual loop
packages/governance         persistent governance files
packages/eternal-engine     V3 governance logic
packages/ui                 reusable Studio UI
```

Do not put filesystem mutation, Git execution, Codex SDK orchestration, or Playwright process logic directly inside React components.

---

## Product Laws

These are non-negotiable:

1. **UX integrity > product consistency > accessibility > visual hierarchy > reference intent > pixel similarity.**
2. Reference is evidence, not a command.
3. Every reference uses **KEEP / REJECT / ADAPT / INVENT**.
4. V1 never mutates target-project code.
5. Safe Mode requires explicit human approval before every new mutation proposal.
6. Mangekyō autonomy is policy-bounded.
7. Autonomous dependency installation is disabled by default.
8. Autonomous navigation changes are disabled by default.
9. Autonomous persistent data-model changes are disabled by default.
10. Autonomous file deletion is disabled by default.
11. Protected paths must not be mutated autonomously.
12. A visual PASS requires a fresh render after the final UI change.
13. Partial evidence cannot produce a whole-product PASS.
14. Repeated drift does not automatically rewrite the Design Genome.
15. `design-governance/` is human-readable product knowledge.
16. `.design-sharingan/` is runtime/machine state.

Fail closed when autonomy or evidence is ambiguous.

---

## Scope Lock — v0.1

In scope:
- Local Folder
- GitHub Repository
- web projects
- references
- V1 SCAN / ASSIMILATE / EVOLVE / VERIFY
- Safe Mode
- Mangekyō Mode
- Playwright web capture
- Design Genome
- Screen Registry
- Drift Audit
- Release Gate
- Reports / evidence

Out of scope:
- native iOS automation
- Android automation
- Flutter rendering
- cloud accounts
- billing
- teams
- cloud sync
- Figma sync
- CI design gate
- PR automation
- hosted SaaS

Do not add out-of-scope features “while you are here.”

---

## Visual Direction

Studio should feel:
- premium;
- young;
- technical;
- calm;
- cinematic only at selected high-value moments;
- information-rich without dashboard clutter.

Avoid:
- generic purple AI gradients;
- excessive glassmorphism;
- constant glow;
- anime cosplay UI;
- cards everywhere;
- motion on every control.

The Sharingan metaphor is a product language layer, not a license to damage professional usability.

---

## Completion Standard

Never say a task, phase, or v0.1 is complete merely because code was written.

Completion requires fresh verification evidence appropriate to the claim.

For v0.1 final acceptance, run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm e2e
```

Also complete the policy pressure checks and real Codex SDK smoke run specified by Task 16.

If a check cannot be run, report **NOT VERIFIED**, not PASS.
