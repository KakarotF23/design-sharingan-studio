---
name: design-sharingan
description: Use when adapting UI screenshots, websites, moodboards, or visual references into an existing product, especially when a feature may affect UX, navigation, information hierarchy, or design-system consistency.
---

# Design Sharingan

## Overview

Design Sharingan turns visual references into reusable product decisions. **Copy the reasoning, not the pixels.** A reference is evidence, not a command.

## Core Laws

1. **Usability > product consistency > reference fidelity.** Never damage UX to match a reference.
2. **Inspect before inventing.** Read current screens, navigation, components, tokens, and `DESIGN.md` first.
3. **Separate principle from branding.** Do not copy logos, proprietary copy, distinctive artwork, or exact branded compositions.
4. **Unify, never collage.** Multiple references must become one coherent system.
5. **Design before implementation.** If UX/navigation/behavior changes, **REQUIRED SUB-SKILL:** use `superpowers:brainstorming` if available and wait for approval before coding.

## Invocation Modes

Interpret `$design-sharingan <mode>`. If omitted, infer the safest mode and state it.

| Mode | Use when | Required output |
|---|---|---|
| `scan` | Studying one reference | KEEP / REJECT / ADAPT / INVENT + Design DNA |
| `assimilate` | Combining 2+ references | Source map + unified Design DNA + proposed `DESIGN.md` changes |
| `evolve` | Adding/changing a product feature | UX impact map + 2–3 approaches + recommendation + approval gate |
| `verify` | Reviewing an implementation | CRITICAL / IMPORTANT / POLISH / IGNORE findings |

## SCAN

Analyze hierarchy, grid, spacing, typography, color, geometry, navigation, density, motion, accessibility, and why the reference works. Output:

- **KEEP:** reusable principles worth preserving
- **REJECT:** attractive choices that do not fit this product
- **ADAPT:** principles to translate into the current design system
- **INVENT:** product needs the reference does not solve
- **Design DNA:** concise token/component/behavior summary using `references/design-dna-schema.md`

Do not code in `scan`.

## ASSIMILATE

Assign each reference a role (hierarchy, cards, navigation, character presentation). Resolve conflicts. Produce one Design DNA. Persist it to `DESIGN.md` from `references/design-md-template.md` only after approval.

## EVOLVE

Map effects on screens, navigation, state, data, notifications, subscription gates, and accessibility. Propose 2–3 UX approaches, recommend one, then **stop for approval**. After approval define screens, components, states, motion, and design-system impact. Stop again if the UI direction materially changes.

## VERIFY

Compare the build against approved Design DNA and references. Classify:

- **CRITICAL:** usability, hierarchy, navigation, broken layout, inaccessible interaction
- **IMPORTANT:** clear design-system or visual-weight mismatch
- **POLISH:** small refinements with low UX impact
- **IGNORE:** pixel differences that do not affect the design intent

Review-only means no code changes. If fixing, prioritize CRITICAL then IMPORTANT and re-test.

## Completion Check

Before completion confirm UX intent, existing patterns, required states, transformed-not-copied references, and standalone coherence.
