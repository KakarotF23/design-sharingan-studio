import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignGenome, ScreenRecord } from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveGenome,
  governanceIsInitialized,
  initializeGovernance,
  readDesignDecisions,
  readGenome,
  readScreenRegistry,
  genomePayloadHash,
  parseGovernanceMetadata,
  renderGenome,
  renderScreenRegistry,
} from "../index";

const roots: string[] = [];

function draftGenome(): DesignGenome {
  return {
    version: "0.1.0",
    status: "DRAFT",
    productIdentity: "A calm local-first design intelligence environment.",
    uxInvariants: ["Keep human decisions explicit."],
    visualInvariants: ["Use one restrained accent."],
    motionRules: ["Reserve motion for state transitions."],
    accessibilityRules: ["Maintain visible focus."],
    componentDNA: ["Use fine rules to separate dense evidence."],
    screenFamilies: ["Project workspaces"],
    contentVoice: ["Calm, technical, and direct."],
    intentionalExceptions: ["Overview may use a wider orientation block."],
    unconfirmedRules: ["Compact density may be preferred on evidence screens."],
  };
}

function screenRecord(): ScreenRecord {
  return {
    id: "screen-overview",
    route: "/overview",
    name: "Overview",
    family: "Project workspaces",
    inheritedRules: ["Keep human decisions explicit."],
    exceptions: ["Overview may use a wider orientation block."],
    requiredStates: ["ready", "needs-configuration"],
    evidence: ["ev_route_overview_01"],
    driftStatus: "NOT_VERIFIED",
  };
}

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "design-sharingan-governance-"));
  roots.push(root);
  return realpath(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Genome governance store", () => {
  it("creates project-scoped human-readable governance with canonical metadata", async () => {
    const root = await projectRoot();

    const created = await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      decisions: [],
    });

    expect(created.genome.metadata).toMatchObject({
      kind: "DESIGN_GENOME",
      projectId: "project-a",
      revision: 1,
      status: "DRAFT",
    });
    expect(created.genome.value.status).toBe("DRAFT");
    expect((await readGenome(root, "project-a")).value).toEqual(draftGenome());
    expect((await readScreenRegistry(root, "project-a")).records).toEqual([screenRecord()]);
    expect((await readDesignDecisions(root, "project-a")).decisions).toEqual([]);

    const directory = join(root, "design-governance");
    const markdown = await readFile(join(directory, "DESIGN-GENOME.md"), "utf8");
    expect(markdown).toContain("# Design Genome");
    expect(markdown).toContain("## Unconfirmed Rules");
    expect(markdown).toContain("Compact density may be preferred");
    await expect(readFile(join(directory, "SCREEN-REGISTRY.md"), "utf8")).resolves.toContain(
      "# Screen Registry",
    );
    await expect(readFile(join(directory, "DESIGN-DECISIONS.md"), "utf8")).resolves.toContain(
      "# Design Decisions",
    );
  });

  it("requires explicit local-user approval before the Genome becomes authoritative", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });

    const approved = await approveGenome(root, "project-a", {
      approvedBy: "local-user",
      expectedRevision: 1,
      expectedPayloadHash: createdPayloadHash(
        await readGenome(root, "project-a"),
      ),
    });

    expect(approved.value.status).toBe("APPROVED");
    expect(approved.metadata).toMatchObject({
      status: "APPROVED",
      revision: 2,
    });
    expect(approved.authority).toBe("AUTHORITATIVE");
    expect(approved.metadata.authority).toMatchObject({
      kind: "GENOME_AUTHORITY",
      approvedBy: "local-user",
      approvedDraftRevision: 1,
      documentRevision: 2,
      projectId: "project-a",
    });
    expect(await readFile(join(root, "design-governance", "DESIGN-GENOME.md"), "utf8"))
      .toContain("**Status:** APPROVED");
  });

  it("serializes concurrent approval and rejects stale revisions", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });

    const results = await Promise.allSettled([
      approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: 1,
        expectedPayloadHash: createdPayloadHash(await readGenome(root, "project-a")),
      }),
      approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: 1,
        expectedPayloadHash: createdPayloadHash(await readGenome(root, "project-a")),
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await readGenome(root, "project-a")).metadata.revision).toBe(2);
  });

  it("atomically serializes concurrent three-document initialization", async () => {
    const root = await projectRoot();
    const input = {
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      decisions: [],
    };
    const results = await Promise.allSettled([
      initializeGovernance(input),
      initializeGovernance(input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(governanceIsInitialized(root)).resolves.toBe(true);
    await expect(readGenome(root, "project-a")).resolves.toMatchObject({
      authority: "NON_AUTHORITATIVE",
      value: { status: "DRAFT" },
    });
  });

  it("pre-renders all documents and leaves no partial governance for an oversized Registry", async () => {
    const root = await projectRoot();
    const records = Array.from({ length: 128 }, (_, index) => ({
      ...screenRecord(),
      id: `screen-${index}`,
      route: `/route-${index}`,
      requiredStates: Array.from({ length: 64 }, (__, state) => `${state}-${"x".repeat(990)}`),
    }));
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: records,
      decisions: [],
    })).rejects.toThrow(/256 KiB/i);
    await expect(governanceIsInitialized(root)).resolves.toBe(false);
  });

  it("recovers only an owned stale lock and owned crash staging residue", async () => {
    const root = await projectRoot();
    const machine = join(root, ".design-sharingan");
    const staging = join(machine, "governance-staging");
    const owner = "11111111-1111-4111-8111-111111111111";
    const ownerDirectory = join(staging, owner);
    await mkdir(join(ownerDirectory, "payload"), { recursive: true });
    await writeFile(join(ownerDirectory, "manifest.json"), JSON.stringify({
      kind: "DESIGN_SHARINGAN_GOVERNANCE_INIT",
      owner,
      pid: 999_999_999,
      projectId: "project-a",
      createdAt: "2000-01-01T00:00:00.000Z",
      files: ["DESIGN-GENOME.md", "SCREEN-REGISTRY.md", "DESIGN-DECISIONS.md"],
    }));
    await writeFile(join(ownerDirectory, "payload", "orphan.tmp"), "owned residue");
    await writeFile(join(machine, "governance.lock"), JSON.stringify({
      kind: "DESIGN_SHARINGAN_GOVERNANCE_LOCK",
      owner: "22222222-2222-4222-8222-222222222222",
      pid: 999_999_999,
      createdAt: "2000-01-01T00:00:00.000Z",
    }));

    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });
    await expect(readFile(join(ownerDirectory, "manifest.json"), "utf8")).rejects.toThrow();
    await expect(governanceIsInitialized(root)).resolves.toBe(true);
  });

  it("never reclaims an ambiguous live lock claim", async () => {
    const root = await projectRoot();
    const machine = join(root, ".design-sharingan");
    await mkdir(machine);
    await writeFile(join(machine, "governance.lock"), JSON.stringify({
      kind: "DESIGN_SHARINGAN_GOVERNANCE_LOCK",
      owner: "33333333-3333-4333-8333-333333333333",
      pid: process.pid,
      createdAt: "2000-01-01T00:00:00.000Z",
    }));
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    })).rejects.toThrow(/busy/i);
    await expect(readFile(join(machine, "governance.lock"), "utf8")).resolves.toContain(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("fails closed for a symlinked governance directory", async () => {
    const root = await projectRoot();
    const outside = await projectRoot();
    await symlink(outside, join(root, "design-governance"));

    await expect(
      initializeGovernance({
        rootPath: root,
        projectId: "project-a",
        genome: draftGenome(),
        screens: [],
        decisions: [],
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a symlink alias instead of treating it as a canonical project root", async () => {
    const target = await projectRoot();
    const aliasParent = await projectRoot();
    const alias = join(aliasParent, "project-alias");
    await symlink(target, alias);

    await expect(
      initializeGovernance({
        rootPath: alias,
        projectId: "project-a",
        genome: draftGenome(),
        screens: [],
        decisions: [],
      }),
    ).rejects.toThrow(/canonical project root/i);
  });

  it("fails closed for hardlinked governance documents", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });
    const genomePath = join(root, "design-governance", "DESIGN-GENOME.md");
    const payloadHash = createdPayloadHash(await readGenome(root, "project-a"));
    await link(genomePath, join(root, "genome-copy.md"));

    await expect(readGenome(root, "project-a")).rejects.toThrow(/hard link/i);
    await expect(
      approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: 1,
        expectedPayloadHash: payloadHash,
      }),
    ).rejects.toThrow(/hard link/i);
  });

  it("rejects governance metadata belonging to another project", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });

    await expect(readGenome(root, "project-b")).rejects.toThrow(/project identity/i);
  });

  it("rejects a stale approval when the exact draft payload hash is not presented", async () => {
    const root = await projectRoot();
    const created = await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });

    await expect(
      approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: created.genome.metadata.revision,
        expectedPayloadHash: "0".repeat(64),
      }),
    ).rejects.toThrow(/payload.*stale|hash.*stale/i);
    expect((await readGenome(root, "project-a")).value.status).toBe("DRAFT");
  });

  it("rejects forged actor, time, status, content, project, revision, root, and hash authority", async () => {
    const root = await projectRoot();
    const created = await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });
    await approveGenome(root, "project-a", {
      approvedBy: "local-user",
      expectedRevision: 1,
      expectedPayloadHash: created.genome.payloadHash,
    });
    const path = join(root, "design-governance", "DESIGN-GENOME.md");
    const original = parseGovernanceMetadata(await readFile(path, "utf8"));
    if (original.kind !== "DESIGN_GENOME" || original.authority === undefined) {
      throw new Error("test fixture lacks authority");
    }
    const genomeMetadata = original;
    const mutations: Array<(metadata: typeof genomeMetadata) => void> = [
      (metadata) => { (metadata.authority as { approvedBy: string }).approvedBy = "agent"; },
      (metadata) => { metadata.authority!.approvedAt = "yesterday"; },
      (metadata) => { metadata.value.status = "DRAFT"; metadata.status = "DRAFT"; },
      (metadata) => {
        metadata.value.uxInvariants = ["Forged exact rule."];
        metadata.authority!.payloadHash = genomePayloadHash(metadata.value);
      },
      (metadata) => { metadata.projectId = "project-b"; metadata.authority!.projectId = "project-b"; },
      (metadata) => { metadata.authority!.documentRevision = 9; },
      (metadata) => { metadata.authority!.rootFingerprint = "1".repeat(64); },
      (metadata) => { metadata.authority!.payloadHash = "2".repeat(64); },
    ];
    for (const mutate of mutations) {
      const forged = structuredClone(genomeMetadata);
      mutate(forged);
      await writeFile(path, renderGenome(forged));
      await expect(readGenome(root, forged.projectId)).rejects.toThrow();
    }
  });

  it("rejects canonical Markdown body tampering and duplicate metadata", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });
    const path = join(root, "design-governance", "DESIGN-GENOME.md");
    const canonical = await readFile(path, "utf8");
    await writeFile(path, canonical.replace("Keep human decisions explicit.", "Silent mutation."));
    await expect(readGenome(root, "project-a")).rejects.toThrow(/canonical|body|mismatch/i);

    await writeFile(path, `${canonical.split("\n")[0]}\n${canonical}`);
    await expect(readGenome(root, "project-a")).rejects.toThrow(/canonical|metadata/i);
  });

  it("round-trips Unicode, newlines, and Markdown structural characters canonically", async () => {
    const root = await projectRoot();
    const unusual = draftGenome();
    unusual.productIdentity = "道具 — line one\n# not a heading <script> -- **literal**";
    unusual.uxInvariants = ["- not a list\n## not a heading `code` 👁️"];
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: unusual,
      screens: [],
      decisions: [],
    });
    expect((await readGenome(root, "project-a")).value).toEqual(unusual);
  });

  it("rejects unsafe, duplicate, and relation-invalid Screen Registry records", async () => {
    const root = await projectRoot();
    const invalid = screenRecord();
    invalid.route = "/overview/../secrets";
    invalid.family = "Unknown family";
    invalid.driftStatus = "PASS";
    invalid.lastVerified = "yesterday";
    await expect(
      initializeGovernance({
        rootPath: root,
        projectId: "project-a",
        genome: draftGenome(),
        screens: [invalid, { ...invalid, id: "screen-other" }],
        decisions: [],
      }),
    ).rejects.toThrow(/route|family|verification|unique/i);
  });

  it("rejects encoded traversal routes and unauthenticated verification claims", async () => {
    const root = await projectRoot();
    const invalid = screenRecord();
    invalid.route = "/%2e%2e/private";
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [invalid],
      decisions: [],
    })).rejects.toThrow(/route/i);
    const ungrounded = screenRecord();
    ungrounded.driftStatus = "PASS";
    ungrounded.lastVerified = "2026-08-30T00:00:00.000Z";
    ungrounded.evidence = [];
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [ungrounded],
      decisions: [],
    })).rejects.toThrow(/evidence|verification/i);
    const unauthenticatedPass = screenRecord();
    unauthenticatedPass.driftStatus = "PASS";
    unauthenticatedPass.lastVerified = "2026-08-30T00:00:00.000Z";
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [unauthenticatedPass],
      decisions: [],
    })).rejects.toThrow(/remains NOT_VERIFIED|authenticated verification/i);
  });

  it("enforces exact Design Decision actor, status, time, and consequential-change proof", async () => {
    const root = await projectRoot();
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [{
        id: "decision-1",
        date: "not-a-time",
        status: "APPROVED",
        scope: "Genome",
        decision: "Rewrite the Genome.",
        reason: "Agent preference.",
        alternatives: [],
        affectedScreens: [],
        affectedComponents: [],
        migrationRequired: true,
        genomeChanges: ["Replace an invariant."],
        approvedBy: "agent",
      }],
    })).rejects.toThrow(/ISO|proof|status|local-user/i);
  });

  it("rejects a canonically rewritten Registry linked to another Genome", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      decisions: [],
    });
    const path = join(root, "design-governance", "SCREEN-REGISTRY.md");
    const registry = parseGovernanceMetadata(await readFile(path, "utf8"));
    if (registry.kind !== "SCREEN_REGISTRY") throw new Error("test Registry kind changed");
    registry.genomeEntityId = "foreign-genome";
    await writeFile(path, renderScreenRegistry(registry));
    await expect(readScreenRegistry(root, "project-a")).rejects.toThrow(/active Design Genome/i);
  });
});

function createdPayloadHash(document: Awaited<ReturnType<typeof readGenome>>): string {
  return document.payloadHash;
}
