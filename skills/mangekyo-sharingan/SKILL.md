---
name: mangekyo-sharingan
description: Use when an approved UI direction or visual reference must be implemented, rendered, visually compared, and iteratively refined without breaking UX, navigation, accessibility, or the existing design system.
---

# Mangekyo Sharingan

## Overview

Mangekyo Sharingan is a visual feedback-loop skill. **Render evidence before visual claims.** It turns approved design intent into a build, inspects the actual rendered result, fixes the highest-impact mismatch, and repeats until the stop gate is satisfied or the iteration budget is exhausted.

## Core Laws

1. **UX integrity > design-system consistency > visual hierarchy > reference intent > pixel similarity.**
2. **Never compare code to an image. Compare a rendered build to an image.**
3. **Never invent screenshots, measurements, or scores.** If capture/render tools are unavailable, switch to audit-only mode and say so.
4. **One loop, one highest-impact objective.** Do not churn many unrelated visual details at once.
5. If a fix changes navigation, behavior, information architecture, or product rules, stop. **REQUIRED SUB-SKILL:** use `superpowers:brainstorming` and get approval before continuing.
6. Before claiming completion, **REQUIRED SUB-SKILL:** use `superpowers:verification-before-completion`.

## Invocation

Use `$mangekyo-sharingan [mode]`. Default mode is `loop`.

| Mode | Purpose |
|---|---|
| `loop` | Build → render → capture → compare → fix → repeat |
| `amaterasu` | Burn down the most damaging visual/UX defects first |
| `tsukuyomi` | Reconstruct why a reference feels the way it does |
| `susanoo` | Guard `DESIGN.md`, tokens, components, states, and accessibility |
| `kamui` | Transfer design logic into the current product without pixel copying |

## Entry Gate

Before changing code, identify: approved design intent, target screen/state, reference(s), current implementation, render/capture path, and iteration budget (default 5). If there is no approved direction and the task affects UX, invoke `design-sharingan evolve` or `superpowers:brainstorming` first.

## Visual Loop

For each iteration:

1. **OBSERVE** — render the exact target state and capture fresh evidence.
2. **DIAGNOSE** — classify findings as CRITICAL / IMPORTANT / POLISH / IGNORE using `references/visual-loop-contract.md`.
3. **CHOOSE** — select the single highest-impact coherent objective.
4. **CHANGE** — make the smallest change set that addresses that objective; preserve existing product rules.
5. **VERIFY** — run relevant functional checks, render again, capture again, and compare.

Never use a pre-change screenshot as post-change evidence.

## Stop Gate

Stop only when fresh evidence shows:

- zero CRITICAL findings;
- no unresolved IMPORTANT finding that blocks the approved design intent;
- UX/navigation/accessibility regressions: zero known;
- design-system guard: pass;
- latest functional verification: pass;
- latest screenshot/render inspected after the final code change.

If the iteration budget ends first, stop and report the remaining ranked issues. Do not claim completion.

## Scoring

A score is optional and heuristic, never “objective similarity.” If useful, apply `references/score-rubric.md` and show the evidence behind each rating. Never fabricate a 90+ score to justify stopping.

## Output Contract

Finish with a **Mangekyo Report**: mode, iterations used, evidence captured, fixes made, CRITICAL/IMPORTANT/POLISH remaining, UX/design-system status, functional verification evidence, and stop reason.

## Example

Partner: “Use this screenshot to refine my existing mobile Home screen. Keep our navigation and brand. Iterate until it feels equally premium.”

Response behavior: confirm the approved direction and capture path → render current Home → identify hierarchy as the top mismatch → adjust only hierarchy/spacing → test → recapture → compare → repeat within budget → finish with evidence-backed Mangekyo Report.

## Red Flags

- “The code looks right, so done.”
- Editing without a fresh baseline render.
- Chasing 1–3 px while CRITICAL hierarchy issues remain.
- Changing navigation to resemble the reference without approval.
- Reporting a score without observable evidence.
- Continuing forever after the iteration budget.
