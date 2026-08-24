# Codex Kickoff Prompt

Paste everything below into a fresh Codex session opened at this project root.

---

You are implementing **Design Sharingan Studio v0.1**.

Before touching code:

1. Read `AGENTS.md`.
2. Read the complete approved spec:
   `docs/superpowers/specs/2026-08-24-design-sharingan-studio-v0.1-design.md`
3. Read the complete implementation plan:
   `docs/superpowers/plans/2026-08-24-design-sharingan-studio-v0.1-implementation-plan.md`
4. Inspect the bundled project skills under `skills/`.
5. Use Superpowers process skills where available.

The architecture and product design have already been approved. Do **not** restart brainstorming or redesign the product unless you discover a concrete contradiction/blocker in the approved documents.

Use **subagent-driven development** as the preferred execution model.

Start with **Task 1: Bootstrap the Monorepo and Test Harness** only.

Requirements for Task 1:
- follow RED → GREEN exactly;
- write the E2E smoke test first;
- run it and confirm the expected failure;
- implement only what Task 1 specifies;
- run the verification commands from Task 1;
- inspect the result against the approved spec;
- commit Task 1 only after verification passes.

Do not begin Task 2 until Task 1 has been verified and reviewed.

While working:
- preserve package boundaries;
- keep UI and local agent/system capabilities separated;
- do not add out-of-scope features;
- do not weaken approval or autonomy boundaries;
- do not claim visual verification without a real rendered artifact;
- report blockers rather than guessing.

At the end of Task 1, report:
1. files created/changed;
2. tests run and exact outcomes;
3. build/typecheck outcome;
4. commit hash if committed;
5. any deviation from the approved plan;
6. whether Task 1 is ready for review.

Begin now with Task 1.
