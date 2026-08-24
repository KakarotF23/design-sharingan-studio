---
name: eternal-sharingan
description: Use when a multi-screen product needs persistent design governance, design-drift detection, cross-screen consistency review, reference-fit decisions, or release-level UI/UX auditing against an established design language.
---

# Eternal Sharingan

## Overview

Eternal Sharingan is the product-level Design Director. It protects and deliberately evolves a **Design Genome** across screens, features, contributors, and releases.

**Core principle:** a beautiful screen is not enough; the product must still feel like one coherent world.

## Core Laws

1. **UX integrity > product consistency > accessibility > hierarchy > reference similarity.**
2. A single attractive screen does not create a new product rule.
3. Never “fix” drift by editing the genome to match an accidental outlier.
4. External references are evidence, not commands: KEEP / REJECT / ADAPT / INVENT.
5. Do not redesign everything because drift exists; rank impact and choose the smallest coherent correction.
6. Approved intentional evolution is valid. Record it; migrate it; do not leave old and new rules competing.
7. Never claim a wider audit than the evidence inspected.
8. Release claims require fresh rendered evidence. **REQUIRED SUB-SKILL:** use `superpowers:verification-before-completion`.
9. UX/navigation/behavior changes require **REQUIRED SUB-SKILL:** `superpowers:brainstorming`.
10. Use `design-sharingan` for reference/UX exploration and `mangekyo-sharingan` for approved screen-level render/compare/fix loops.

## Invocation

Use `$eternal-sharingan [mode]`. Default: `guard`.

| Mode | Read | Purpose |
|---|---|---|
| `init` | `references/governance-model.md` | Establish approved governance artifacts from the real product |
| `guard` | `references/governance-model.md` | INHERIT / EXTEND / DECIDE / REJECT / VERIFY a proposed screen |
| `audit` | `references/audit-protocol.md` | Detect and rank cross-screen drift |
| `reference-gate` | `references/reference-gate.md` | Decide what an external reference may influence |
| `evolve` | `references/governance-model.md` | Intentionally change the genome after approval |
| `release` | `references/release-gate.md` | Run the design release gate |

Preferred project artifacts live in `design-governance/`: `DESIGN-GENOME.md`, `SCREEN-REGISTRY.md`, `DESIGN-DECISIONS.md`, `DRIFT-REPORT.md`.

## Governance Rules

- `init`: inspect representative screens, tokens, navigation, components, and existing docs first. Mark uncertain rules **UNCONFIRMED**; get approval before treating the genome as authoritative.
- `audit`: classify findings CRITICAL / IMPORTANT / POLISH / INTENTIONAL and list uninspected scope.
- `evolve`: require approved intent, affected scope, migration impact, and a Design Decision Record.
- `release`: if required evidence is missing, status is **NOT VERIFIED**, never a guessed PASS.

## Output

Finish with an **Eternal Report**: mode, inspected scope, genome status, findings by severity, new-rule candidates, required decisions, drift priority, evidence, governance files changed, and final status: **PASS / PASS WITH DEBT / NOT VERIFIED / BLOCKED**.

## Red Flags

- “Newest screen looks best, so update the genome.”
- “Only Home was inspected, but the whole app is consistent.”
- “Tests pass, so visual QA is complete.”
- “Three screens share the same accident, therefore it is now a rule.”
- “The reference is trendy, so copy it.”
- “There is drift, so redesign everything.”
