# Design Sharingan Studio v0.1 — Product & Architecture Specification

**Date:** 2026-08-24  
**Status:** Draft for final user review  
**Architecture:** Next.js local web app + Node agent layer  
**Project sources:** Local Folder + GitHub Repository  
**Execution modes:** Safe Mode + Mangekyō Mode

## 1. Product Definition

Design Sharingan Studio is a local-first visual design intelligence environment for Codex.

Its closed loop is:

**Reference → Understand → Adapt → Approve → Build → Render → Compare → Refine → Govern**

It combines three layers:

- **V1 — Design Sharingan:** reference analysis, Design DNA, UX impact, design approaches.
- **V2 — Mangekyō Sharingan:** controlled implementation, render/capture/compare/fix loops.
- **V3 — Eternal Sharingan:** Design Genome, screen registry, drift detection, design decisions, release governance.

Core principle:

> **Copy the reasoning, not the pixels.**

## 2. v0.1 Goals

The system must let a user:

- open an existing local web project;
- import a GitHub repository into a local workspace;
- upload and organize design references;
- run SCAN / ASSIMILATE / EVOLVE / VERIFY;
- extract KEEP / REJECT / ADAPT / INVENT;
- create a Feature Brief and UX Impact Map;
- compare 2–3 design approaches before implementation;
- approve or reject proposed code mutations;
- run a web project locally;
- capture rendered UI with Playwright;
- compare reference and current rendered output;
- iterate visually under explicit autonomy limits;
- initialize and approve a Design Genome;
- register screens and screen families;
- audit design drift;
- run a release gate backed by fresh evidence.

The user must always know:

- what the agent is doing;
- what evidence it is using;
- what it wants to change;
- whether approval is required;
- what changed;
- what was rendered;
- what was actually verified.

## 3. Explicit Non-Goals

v0.1 does not include:

- native iOS simulator automation;
- Android emulator automation;
- Flutter native rendering automation;
- hosted SaaS mode;
- accounts, billing, teams, or cloud sync;
- CI/CD design gates;
- Figma synchronization;
- automatic PR review;
- production deployment.

The architecture should allow future adapters without rewriting the core domain.

## 4. Product Laws

1. **UX integrity > product consistency > accessibility > visual hierarchy > reference intent > pixel similarity.**
2. References are evidence, not commands.
3. Every reference goes through **KEEP / REJECT / ADAPT / INVENT**.
4. Approval is a first-class object: **Proposal → Human Decision → Execution**.
5. Evidence is a first-class object: a PASS must trace back to actual render/test/screen/session/round/decision evidence.
6. Workflow state uses explicit state machines, not overlapping booleans.
7. Repeated drift is still drift; only an approved design decision changes the Design Genome.
8. V1 never mutates target-project code.
9. Safe Mode never mutates without explicit approval.
10. Mangekyō Mode may act autonomously only inside its approved policy.
11. Missing fresh rendered evidence means visual status is **NOT VERIFIED**.

## 5. Repository Architecture

```text
design-sharingan-studio/
├── apps/
│   └── studio/
├── packages/
│   ├── core/
│   ├── project-adapters/
│   ├── sharingan-engine/
│   ├── mangekyo-engine/
│   ├── eternal-engine/
│   ├── approval-engine/
│   ├── render-engine/
│   ├── visual-engine/
│   ├── governance/
│   └── ui/
├── skills/
│   ├── design-sharingan/
│   ├── mangekyo-sharingan/
│   └── eternal-sharingan/
├── docs/
├── examples/
├── tests/
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

Tooling:

- **pnpm workspace**
- **Turborepo**
- **Next.js + React**
- **Tailwind CSS**
- **Node.js local services**
- **Playwright**
- **local JSON / Markdown / filesystem artifacts**

### 5.1 `apps/studio`

Owns UI, routing, intake, references, approvals, session visualization, evidence presentation, status, and activity.

It must not contain core Git, filesystem mutation, Playwright automation, or governance logic.

### 5.2 `packages/core`

Shared domain contracts:

- Project
- ProjectCapability
- Reference
- DesignSession
- DesignDNA
- FeatureBrief
- UXImpact
- DesignApproach
- ChangeProposal
- Approval
- RenderArtifact
- VisualRound
- VisualFinding
- DesignGenome
- ScreenRecord
- DesignDecision
- DriftFinding
- ReleaseGate

### 5.3 `packages/project-adapters`

Both project sources resolve to one `ProjectWorkspace`.

**LocalProjectAdapter** detects framework, package manager, scripts, routes, components, design documents, Git state, and runtime capability.

**GitHubProjectAdapter** supports public repository URL, branch selection, basic token-based private access, local clone, and the same project-inspection pipeline used by local projects.

### 5.4 `packages/sharingan-engine`

Modes:
- scan
- assimilate
- evolve
- verify

Outputs:
- Design DNA
- KEEP / REJECT / ADAPT / INVENT
- UX Impact Map
- 2–3 Design Approaches
- recommendation

No target-project mutation.

### 5.5 `packages/mangekyo-engine`

Owns:

**Prepare → Policy Check → Edit → Run → Capture → Compare → Decide → Fix / Complete / Human Gate**

Tracks visual rounds and fresh evidence.

### 5.6 `packages/approval-engine`

Modes:

**Safe Mode:** every new mutation proposal requires human approval.

**Mangekyō Mode:** visual-only corrections may proceed automatically inside policy bounds.

Default autonomous policy:

| Capability | Default |
|---|---|
| Style changes | Allowed |
| Small component refactor | Limited |
| New presentational component | Allowed |
| Dependency install | Not allowed |
| Navigation change | Not allowed |
| Data-model change | Not allowed |
| File deletion | Not allowed |
| Protected-path mutation | Not allowed |

Human escalation choices:
- Reject
- Approve Once
- Expand Scope

Default: **Approve Once**.

### 5.7 `packages/render-engine`

v0.1 supports web projects only.

Flow:

**Detect dev command → Start server → Wait ready → Open Playwright → Navigate → Set viewport → Capture → Persist artifact**

Initial viewports:
- Mobile Web
- Tablet
- Desktop

### 5.8 `packages/visual-engine`

Finding severities:
- CRITICAL
- IMPORTANT
- POLISH
- IGNORE

Finding categories:
- HIERARCHY
- TYPOGRAPHY
- SPACING
- LAYOUT
- DENSITY
- COMPONENT
- COLOR
- MOTION
- ACCESSIBILITY
- RESPONSIVE
- GENOME

It evaluates structural evidence and design-intelligence evidence. Pixel difference may be supplementary but never the sole quality metric.

### 5.9 `packages/eternal-engine`

Services:
- GenomeService
- ScreenRegistryService
- DecisionService
- DriftService
- ReleaseGateService

Governance files:

```text
design-governance/
├── DESIGN-GENOME.md
├── SCREEN-REGISTRY.md
├── DESIGN-DECISIONS.md
└── DRIFT-REPORT.md
```

## 6. Target Project Storage

Machine/runtime artifacts:

```text
.design-sharingan/
├── project.json
├── references/
├── sessions/
├── renders/
└── cache/
```

Human-readable governance:

```text
design-governance/
├── DESIGN-GENOME.md
├── SCREEN-REGISTRY.md
├── DESIGN-DECISIONS.md
└── DRIFT-REPORT.md
```

Recommended source-control behavior:
- commit `design-governance/`;
- ignore caches and temporary renders;
- retain render evidence intentionally when useful.

## 7. Routes

```text
/
├── /projects
└── /projects/:projectId
    ├── /overview
    ├── /references
    ├── /learn
    ├── /execute
    ├── /govern
    ├── /reports
    └── /settings
```

## 8. Studio Shell

```text
┌────────────┬────────────────────────────┬─────────────┐
│ SIDEBAR    │ WORKSPACE                  │ CONTEXT     │
│            │                            │ PANEL       │
├────────────┴────────────────────────────┴─────────────┤
│ ACTIVITY / AGENT / RENDER / GIT                      │
└───────────────────────────────────────────────────────┘
```

Sidebar:

```text
PROJECT
● Project Name

OVERVIEW
⌂ Overview

SHARINGAN
◉ References
👁 Learn
👁‍🗨 Execute
♾ Govern

SYSTEM
▤ Reports
⚙ Settings
```

Project health:
- Genome
- Dev server
- Git state

## 9. Landing & Project Intake

Landing primary actions:
- **Open Local Project**
- **Import GitHub Repo**

Local flow:

**Select Folder → Scan → Detected Configuration → User Review → Open Studio**

GitHub flow:

**Repository URL / Branch / Auth → Clone → Local Workspace → Scan → User Review → Open Studio**

If framework/dev command/target cannot be determined, project becomes `NEEDS_CONFIGURATION`.

After intake, Local and GitHub projects have the same Studio experience.

## 10. Overview Workspace

Shows:
- Design Genome status/coverage;
- registered screens;
- current drift;
- latest visual run;
- references.

Primary actions:
- Analyze Reference
- Improve a Screen
- Audit Product

Recent activity comes from `DesignSession` history.

## 11. References Workspace

Each reference stores:
- title;
- source;
- screenshot;
- tags;
- likes;
- dislikes;
- notes;
- analysis state;
- compatibility;
- sessions using it.

Reference analysis does **not** automatically change the Product Design Genome.

## 12. Learn Workspace

Modes:
- SCAN
- ASSIMILATE
- EVOLVE
- VERIFY

### SCAN
Input:
- one reference;
- optional notes;
- optional selected qualities;
- optional “I don't know — analyze it for me”.

Output:
- Design DNA;
- KEEP / REJECT / ADAPT / INVENT.

### ASSIMILATE
Input:
- multiple references;
- optional reference-specific learning intent.

Output:
- one coherent proposed design direction.

No automatic Genome update.

### EVOLVE
Input:
- FeatureBrief;
- optional references;
- project context;
- constraints.

Output:
- UX Impact Map;
- 2–3 approaches;
- recommendation;
- likely affected screens/components/files;
- complexity;
- Genome fit.

Implementation begins only after approval.

### VERIFY
Compares intended design logic with the current direction/result.

Findings:
- CRITICAL
- IMPORTANT
- POLISH
- IGNORE

## 13. Execute Workspace

Mode selector:
- **Safe Mode**
- **Mangekyō Mode**

### Safe Mode

Before mutation, display ChangeProposal:
- reason;
- files create/modify/delete;
- screens affected;
- components affected;
- UX impact;
- visual impact;
- risk;
- policy violations.

Actions:
- View Diff Plan
- Approve & Execute
- Request Revision
- Reject

**No mutation occurs before approval.**

Every new mutation loop requires new approval.

### Mangekyō Mode

Displays:
- round number;
- build/run/capture/compare/fix status;
- reference vs current render;
- findings;
- round history;
- UX integrity;
- Genome integrity.

Stop when:
- quality criteria pass;
- maxRounds reached;
- user stops;
- critical build failure;
- policy boundary requires unresolved approval.

Quality criteria:
- CRITICAL = 0
- UX regressions = 0
- unresolved Genome conflicts = 0
- IMPORTANT <= configured threshold
- fresh final render exists

A visual score may be shown, but it is not the sole stop condition.

## 14. Human Escalation

When autonomy is exceeded, state becomes `HUMAN_GATE`.

The UI must show:
- requested change;
- why it exceeded policy;
- affected scope;
- impact.

Choices:
- Reject
- Approve Once
- Expand Scope

## 15. Govern Workspace

Sections:
- GENOME
- SCREENS
- DRIFT
- RELEASE

### Genome
Shows:
- Product Identity
- UX Invariants
- Visual Invariants
- Motion Rules
- Accessibility Rules
- Component DNA
- Screen Families
- Content Voice
- Intentional Exceptions
- Unconfirmed Rules

A Genome is authoritative only when `APPROVED`.

### Screen Registry
Tracks:
- route;
- family;
- inherited rules;
- exceptions;
- required states;
- evidence;
- drift status;
- last verification.

### Drift
Severity:
- CRITICAL
- IMPORTANT
- POLISH
- INTENTIONAL

Each finding includes:
- expected rule;
- observed evidence;
- why it matters;
- smallest coherent fix;
- whether a design decision is required.

A drift finding can start a new Execute session.

### Release
Checks:
- navigation;
- accessibility;
- critical drift;
- unapproved design rules;
- screen registration;
- required states;
- fresh renders;
- design decisions;
- functional verification.

Statuses:
- PASS
- PASS_WITH_DEBT
- NOT_VERIFIED
- BLOCKED

No PASS without fresh evidence across the claimed scope.

## 16. Context & Activity Panels

Context examples:
- Learn: references, goal, constraints, Genome status.
- Execute: route, viewport, references, mode, autonomy policy.
- Govern: audit scope, evidence coverage, missing evidence.

Activity tabs:
- ACTIVITY
- AGENT
- RENDER
- GIT

Use concrete states:
- Analyzing reference
- Preparing change proposal
- Waiting for approval
- Starting dev server
- Capturing `/home`
- Comparing render
- Human decision required
- Release evidence incomplete

Avoid generic “Thinking…” as the primary status.

## 17. Component System

### Primitives
Button, IconButton, Input, Textarea, Select, Tabs, Badge, Tooltip, Popover, Dialog, Sheet, Card, Divider, ScrollArea, Progress, Skeleton, Toast.

### Studio Components
StudioShell, Sidebar, ContextPanel, ActivityPanel, ProjectHeader, WorkspaceHeader, StatusBadge, ApprovalBanner, InspectorSection, EvidenceCard, FindingCard, SessionTimeline, ModeSwitcher.

### Sharingan Components

V1:
- ReferenceCard
- DesignDNAView
- KRAIGrid
- UXImpactMap
- ApproachCard

V2:
- VisualCompare
- VisualRoundTimeline
- FindingCard
- AutonomyBoundaryCard

V3:
- GenomeRule
- ScreenRegistryRow
- DriftCard
- ReleaseGateChecklist

## 18. Explicit State Machines

### Project
`UNINITIALIZED → SCANNING → READY`

Alternate:
`SCANNING → NEEDS_CONFIGURATION → READY`

### Reference
`UPLOADED → PROCESSING → READY → ANALYZED → ASSIMILATED`

ASSIMILATED does not imply Genome adoption.

### Learn Session
`DRAFT → ANALYZING → RESULT_READY → AWAITING_DECISION`

Decision:
- APPROVED
- REVISE
- REJECT

Only approved work may be sent to Execute.

### Safe Mode
`IDLE → PREPARING → PROPOSING → WAITING_APPROVAL`

Approved:
`→ EDITING → RUNNING → CAPTURING → VERIFYING → COMPLETE`

Revision:
`WAITING_APPROVAL → REVISING → PROPOSING`

Failure:
`RUNNING → FAILED`

Another required mutation:
`VERIFYING → PROPOSING`

### Mangekyō Mode
`IDLE → PREPARING → POLICY_CHECK → EDITING → RUNNING → CAPTURING → COMPARING → DECIDING`

Success:
`DECIDING → COMPLETE`

Autonomous fix:
`DECIDING → FIXING → POLICY_CHECK → EDITING`

Escalation:
`DECIDING → HUMAN_GATE`

Approved escalation:
`HUMAN_GATE → POLICY_CHECK`

Rejected escalation:
`HUMAN_GATE → BLOCKED`

## 19. Core Data Contracts

### Project
`id, name, sourceType, rootPath, repositoryUrl, branch, framework, packageManager, devCommand, status, createdAt, updatedAt`

### ProjectCapability
`canReadFiles, canWriteFiles, canRun, canRender, canCapture, canUseGit, canAudit`

### Reference
`id, projectId, title, type, source, imagePath, notes, likes[], dislikes[], tags[], analysisStatus, compatibility, createdAt`

### DesignDNA
`id, referenceIds[], hierarchy, layout, spacing, typography, colorLogic, componentGeometry, navigation, interaction, motion, density, emotionalTone, visualWeight, keep[], reject[], adapt[], invent[]`

### FeatureBrief
`name, goal, description, constraints[], mustKeep[], mustNotChange[], successCriteria[]`

### UXImpact
`area, severity, reason, affectedRoutes[], affectedComponents[], decisionRequired`

### DesignApproach
`id, title, summary, recommended, pros[], cons[], uxImpact[], estimatedComplexity, genomeFit, likelyFiles[], status`

### ChangeProposal
`id, sessionId, summary, reason, filesToCreate[], filesToModify[], filesToDelete[], componentsAffected[], screensAffected[], uxImpact, visualImpact, riskLevel, requiresHumanApproval, policyViolations[], status`

### Approval
`id, proposalId, decision, scope, approvedBy, comment, createdAt`

Decision values:
- APPROVED
- REJECTED
- REVISION_REQUESTED

### VisualRound
`roundNumber, startedAt, completedAt, beforeRender, afterRender, filesChanged[], findingsBefore[], actions[], findingsAfter[], criticalCount, importantCount, polishCount, uxIntegrity, genomeIntegrity, status`

### VisualFinding
`id, severity, category, screen, description, evidence, reason, recommendedAction, status`

### DesignGenome
`version, status, productIdentity, uxInvariants[], visualInvariants[], motionRules[], accessibilityRules[], componentDNA[], screenFamilies[], contentVoice[], intentionalExceptions[], unconfirmedRules[]`

Status:
- DRAFT
- APPROVED

### ScreenRecord
`id, route, name, family, inheritedRules[], exceptions[], requiredStates[], evidence[], driftStatus, lastVerified`

### DesignDecision
`id, date, status, scope, decision, reason, alternatives[], affectedScreens[], affectedComponents[], migrationRequired, genomeChanges[], approvedBy`

### DriftFinding
`severity, scope, expectedRule, observedEvidence, whyItMatters, recommendedFix, requiresDesignDecision, status`

### ReleaseGate
`scope, checks[], navigation, accessibility, criticalDrift, newDesignRules, screenRegistration, requiredStates, freshRenders, decisions, functionalVerification, status`

## 20. Session Model

All meaningful activity belongs to a `DesignSession`.

Types:
- REFERENCE_SCAN
- ASSIMILATION
- FEATURE_EVOLVE
- SAFE_EXECUTION
- MANGEKYO_LOOP
- GENOME_INIT
- DRIFT_AUDIT
- RELEASE_GATE

Reports are primarily a history/inspection view over Design Sessions.

## 21. Security & Mutation Boundaries

v0.1 must:
- clearly identify the active project;
- scope filesystem operations to that workspace;
- fail closed if policy state is ambiguous;
- prevent autonomous mutation of protected paths;
- never autonomously install dependencies by default;
- never autonomously delete files by default;
- never autonomously change navigation architecture by default;
- never autonomously change persistent data models by default;
- never expose repository tokens in project logs;
- keep private repository credentials outside project source;
- show Git status before and after mutation where Git is available.

## 22. Acceptance Criteria

### Flow A — Reference Analysis
1. Open project.
2. Upload screenshot.
3. Run SCAN.
4. Receive Design DNA.
5. Receive KEEP / REJECT / ADAPT / INVENT.
6. Save session.

### Flow B — Feature UX Evolution
1. Create Feature Brief.
2. Run EVOLVE.
3. See UX Impact Map.
4. Receive 2–3 approaches.
5. Approve one.
6. Send it to Execute.

### Flow C — Safe Mode
1. Receive approved direction.
2. Create Change Proposal.
3. Display affected files/components/screens.
4. User approves.
5. Apply mutation.
6. Run web project.
7. Capture fresh render.
8. Verify.
9. Save evidence and session.

### Flow D — Mangekyō Loop
1. Start with approved direction and explicit policy.
2. Apply allowed visual correction.
3. Run.
4. Capture.
5. Compare.
6. Record findings.
7. Repeat while within policy and stop criteria.
8. Escalate policy-boundary changes.
9. Finish only with fresh final evidence.

### Flow E — Design Genome
1. Initialize from real project evidence.
2. Mark uncertainty UNCONFIRMED.
3. User approves Genome.
4. Register representative screens.

### Flow F — Drift Audit
1. Select scope.
2. Enumerate inspected/unavailable screens.
3. Compare evidence with approved Genome.
4. Rank findings.
5. Save/update DRIFT-REPORT.

### Flow G — Release Gate
1. Select scope.
2. Verify navigation.
3. Verify accessibility.
4. Check critical drift.
5. Check new rules.
6. Check registration.
7. Check required states.
8. Check fresh renders.
9. Check design decisions.
10. Return PASS / PASS_WITH_DEBT / NOT_VERIFIED / BLOCKED with evidence.

## 23. Testing Strategy

### Unit
- state transitions;
- autonomy policy;
- stop criteria;
- adapters;
- session persistence;
- release-gate evaluation;
- drift classification.

### Integration
- LocalProjectAdapter → ProjectWorkspace;
- GitHubProjectAdapter → ProjectWorkspace;
- approval → mutation;
- render engine → screenshot artifact;
- visual findings → VisualRound;
- Genome → drift report.

### End-to-End
- intake;
- reference upload;
- Learn;
- Safe approval;
- Mangekyō escalation;
- Govern;
- Release gate.

### Pressure / Policy
Verify that:
- autonomous mode cannot silently install dependencies;
- autonomous mode cannot silently change navigation;
- autonomous mode cannot silently delete files;
- missing final render prevents visual PASS;
- one inspected screen cannot produce a whole-app PASS;
- repeated drift cannot automatically rewrite the Genome.

## 24. Visual Direction

The Studio should feel:
- premium;
- young;
- technical;
- cinematic at selected high-value moments;
- calm during routine operation;
- information-rich without dashboard clutter.

Avoid:
- generic purple AI SaaS gradients;
- excessive glassmorphism;
- constant glow;
- animation on every control;
- dashboard-card overload;
- literal anime imitation that harms professional usability.

The Sharingan metaphor should influence language, hierarchy, and selected visual moments—not turn every control into themed decoration.

## 25. Implementation Phases

### Phase 1 — Foundation
- monorepo;
- Studio shell;
- Local Project intake;
- GitHub public import;
- project scan;
- References;
- Learn workspace.

### Phase 2 — Safe Execution
- approval engine;
- ChangeProposal;
- controlled mutation;
- dev server;
- Playwright capture;
- evidence persistence.

### Phase 3 — Mangekyō
- autonomy policy;
- visual rounds;
- comparison workflow;
- stop criteria;
- human escalation;
- visual history.

### Phase 4 — Eternal
- Genome initialization;
- Screen Registry;
- Design Decisions;
- Drift Audit;
- Release Gate.

Basic private GitHub token support may land in Phase 1 or Phase 2, but must not block the public-repository workflow.

## 26. Definition of v0.1 Success

v0.1 succeeds when a user can take an existing web project, provide a visual reference and feature goal, approve a UX direction, allow a controlled implementation, inspect the real rendered result, iteratively refine it within explicit autonomy boundaries, and preserve the resulting product knowledge in a governed Design Genome.

The proof is the complete evidence-backed loop:

> **Reference → Design Intelligence → Human Decision → Code Change → Real Render → Visual Review → Product Governance**
