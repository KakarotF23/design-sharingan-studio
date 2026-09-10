import type { DesignGenome, FeatureBrief } from "@design-sharingan/core";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveGenome, initializeGovernance } from "@design-sharingan/governance";
import { describe, expect, it } from "vitest";
import { guardFeature } from "../guard";

const featureBrief: FeatureBrief = {
  name: "Evidence inbox",
  goal: "Help reviewers triage unresolved evidence.",
  description: "Add a bounded evidence inbox.",
  constraints: ["Reuse the project workspace shell."],
  mustKeep: ["Reports remain the durable history."],
  mustNotChange: ["Do not change navigation."],
  successCriteria: ["A reviewer can triage one item in under a minute."],
};

function genome(status: DesignGenome["status"]): DesignGenome {
  return {
    version: "0.1.0",
    status,
    productIdentity: "A calm local-first design intelligence environment.",
    uxInvariants: ["Keep human decisions explicit."],
    visualInvariants: ["Use one restrained accent."],
    motionRules: ["Reserve motion for state transitions."],
    accessibilityRules: ["Maintain visible focus."],
    componentDNA: ["Use fine rules to separate dense evidence."],
    screenFamilies: ["Project workspaces"],
    contentVoice: ["Calm, technical, and direct."],
    intentionalExceptions: [],
    unconfirmedRules: ["Compact density may be preferred on evidence screens."],
  };
}

describe("Eternal feature guard", () => {
  it("does not treat a draft genome as authoritative", async () => {
    const result = await guardFeature({ genome: genome("DRAFT"), featureBrief });

    expect(result.genomeAuthority).toBe("NON_AUTHORITATIVE");
    expect(result.DECIDE).toContain(
      "Compact density may be preferred on evidence screens.",
    );
  });

  it("does not automatically modify Genome invariants after repeated drift", async () => {
    const current = genome("APPROVED");
    const original = structuredClone(current);

    const result = await guardFeature({
      genome: current,
      featureBrief,
      repeatedPatterns: [
        {
          rule: "Use glowing borders on evidence panels.",
          screens: ["/overview", "/learn", "/reports"],
          classification: "DRIFT",
        },
      ],
    });

    expect(current).toEqual(original);
    expect(result.DECIDE).toContain("Use glowing borders on evidence panels.");
    expect(result.INHERIT).not.toContain("Use glowing borders on evidence panels.");
    expect(Object.keys(result).sort()).toEqual(
      ["DECIDE", "EXTEND", "INHERIT", "REJECT", "VERIFY", "genomeAuthority"].sort(),
    );
  });

  it("returns only bounded guard dispositions and fresh verification needs", async () => {
    const result = await guardFeature({ genome: genome("APPROVED"), featureBrief });

    expect(result.genomeAuthority).toBe("NON_AUTHORITATIVE");
    expect(result.INHERIT).toEqual([]);
    expect(result.DECIDE).toEqual(expect.arrayContaining([
      "Keep human decisions explicit.",
      "Use one restrained accent.",
      "Maintain visible focus.",
    ]));
    expect(result.REJECT).toEqual(["Do not change navigation."]);
    expect(result.VERIFY).toEqual([
      "A reviewer can triage one item in under a minute.",
      "Capture fresh rendered evidence for the affected screens and states.",
    ]);
    for (const values of [
      result.INHERIT,
      result.EXTEND,
      result.DECIDE,
      result.REJECT,
      result.VERIFY,
    ]) {
      expect(values.length).toBeLessThanOrEqual(64);
      expect(values.every((value) => value.length > 0 && value.length <= 1_000)).toBe(true);
    }
  });

  it("inherits only from an authenticated exact local-user Genome document", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "guard-authority-")));
    try {
      const draft = genome("DRAFT");
      draft.uxInvariants = [];
      draft.unconfirmedRules = [
        "Keep human decisions explicit.",
        ...draft.unconfirmedRules,
      ];
      const created = await initializeGovernance({
        rootPath: root,
        projectId: "project-a",
        genome: draft,
        screens: [],
        decisions: [],
        evidenceCatalog: [{
          id: "ev_render_guard_01",
          kind: "RENDER",
          route: "/overview",
          excerpt: "Authenticated current render for the explicit decision rule.",
          verifiedClaims: [],
          authenticatedRenderId: "render-guard-01",
          renderState: "default",
          renderCapturedAt: "2026-09-08T00:00:00.000Z",
          renderSourceRevisionFingerprint: "a".repeat(64),
        }],
        inspectedScope: {
          representative: true,
          routes: ["/overview"],
          evidenceIds: ["ev_render_guard_01"],
        },
        claimCitations: [{
          id: "claim-guard-human-decisions",
          claimType: "RULE",
          category: "UX_INVARIANT",
          statement: "Keep human decisions explicit.",
          confidence: "UNCONFIRMED",
          requestedConfidence: "CONFIRMED",
          scope: { routes: ["/overview"] },
          evidenceIds: ["ev_render_guard_01"],
        }],
      });
      const approved = await approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: created.genome.metadata.revision,
        expectedPayloadHash: created.genome.payloadHash,
        acceptedClaim: {
          claimId: "claim-guard-human-decisions",
          claimType: "RULE",
          category: "UX_INVARIANT",
          statement: "Keep human decisions explicit.",
          evidenceId: "ev_render_guard_01",
          route: "/overview",
          state: "default",
          authenticatedRenderId: "render-guard-01",
          sourceRevisionFingerprint: "a".repeat(64),
        },
      });

      const verified = await guardFeature({ genome: approved, featureBrief });
      expect(verified.genomeAuthority).toBe("AUTHORITATIVE");
      expect(verified.INHERIT).toContain("Keep human decisions explicit.");

      const forged = structuredClone(approved);
      forged.value.uxInvariants = ["Forged invariant."];
      const rejected = await guardFeature({ genome: forged, featureBrief });
      expect(rejected.genomeAuthority).toBe("NON_AUTHORITATIVE");
      expect(rejected.INHERIT).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
