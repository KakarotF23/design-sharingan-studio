# 👁 Design Sharingan Studio — Codex Project Kickoff Pack

This folder is the ready-to-open project handoff for building **Design Sharingan Studio v0.1** in Codex.

## Fast Start

### 1. Unzip this pack

Open the extracted `design-sharingan-studio-codex-kickoff-pack` folder as a project in Codex.

### 2. Install the bundled Sharingan skills

From the project root:

```bash
bash scripts/install-project-skills.sh
```

Then start a **new Codex session** so the skills are discovered.

Verify:

```bash
bash scripts/verify-kickoff-pack.sh
```

### 3. Paste the kickoff prompt

Open:

```text
CODEX-KICKOFF-PROMPT.md
```

Copy the prompt into the new Codex session.

### 4. Codex starts with Task 1

Do not ask Codex to “build everything at once.”

The implementation plan is intentionally split into 16 verified tasks.

---

## Core Files

```text
AGENTS.md
CODEX-KICKOFF-PROMPT.md
docs/superpowers/specs/2026-08-24-design-sharingan-studio-v0.1-design.md
docs/superpowers/plans/2026-08-24-design-sharingan-studio-v0.1-implementation-plan.md
skills/
  design-sharingan/
  mangekyo-sharingan/
  eternal-sharingan/
scripts/
  install-project-skills.sh
  verify-kickoff-pack.sh
  show-next-step.sh
PROJECT-MANIFEST.md
```

## What Each File Does

**AGENTS.md**  
Hard project rules Codex should keep in context while working.

**Product & Architecture Spec**  
The approved product definition and architecture. It is the design source of truth.

**Implementation Plan**  
The exact 16-task build order, tests, files, commands, and commit checkpoints.

**skills/**  
The complete V1/V2/V3 Design Sharingan skill system.

**CODEX-KICKOFF-PROMPT.md**  
Ready-to-paste first instruction for Codex.

---

## Build Philosophy

```text
Reference
   ↓
👁 Design Sharingan
   ↓
Human-approved UX direction
   ↓
👁‍🗨 Mangekyō
   ↓
Real rendered visual loop
   ↓
♾ Eternal
   ↓
Design Genome / drift / release governance
```

The system should learn design logic, not clone pixels.

## Recommended Codex Execution Mode

Use **Subagent-Driven Development** if available:

```text
Task
 ↓
Fresh implementer
 ↓
Tests
 ↓
Spec-compliance review
 ↓
Code-quality review
 ↓
Accept
 ↓
Next task
```

This gives the project the cleanest review boundary because the implementation plan is already split around package/domain boundaries.
