import { link, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignGenome, ScreenRecord } from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveGenome,
  initializeGovernance,
  readDesignDecisions,
  readGenome,
  readScreenRegistry,
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
    intentionalExceptions: [],
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
    evidence: ["route detection: /overview"],
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
    });

    expect(approved.value.status).toBe("APPROVED");
    expect(approved.metadata).toMatchObject({
      status: "APPROVED",
      approvedBy: "local-user",
      revision: 2,
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
      approveGenome(root, "project-a", { approvedBy: "local-user", expectedRevision: 1 }),
      approveGenome(root, "project-a", { approvedBy: "local-user", expectedRevision: 1 }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await readGenome(root, "project-a")).metadata.revision).toBe(2);
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
    await link(genomePath, join(root, "genome-copy.md"));

    await expect(readGenome(root, "project-a")).rejects.toThrow(/hard link/i);
    await expect(
      approveGenome(root, "project-a", { approvedBy: "local-user", expectedRevision: 1 }),
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
});
