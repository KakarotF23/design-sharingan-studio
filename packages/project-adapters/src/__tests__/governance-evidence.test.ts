import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGovernanceEvidence } from "../governance-evidence";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "governance-evidence-")));
  roots.push(root);
  await mkdir(join(root, "components"));
  await writeFile(join(root, "README.md"), "Product is calm. token=super-secret-value /Users/alice/private.env\n");
  await writeFile(join(root, "components", "Nav.tsx"), "export function Nav(){ return <nav>Projects</nav> }\n");
  return root;
}

describe("governance representative evidence", () => {
  it("returns bounded server identities and sanitized read-only excerpts", async () => {
    const root = await fixture();
    let sequence = 0;
    const evidence = await collectGovernanceEvidence({
      rootPath: root,
      projectId: "project-a",
      routes: ["/", "/overview"],
      designDocuments: ["README.md"],
      componentDirectories: ["components"],
      createId: () => `ev_server_${String(++sequence).padStart(8, "0")}`,
    });

    expect(evidence.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "ROUTE", "DOCUMENT", "NAVIGATION",
    ]));
    expect(new Set(evidence.map((item) => item.id)).size).toBe(evidence.length);
    expect(evidence.every((item) => /^ev_[a-zA-Z0-9_-]{8,125}$/.test(item.id))).toBe(true);
    const text = JSON.stringify(evidence);
    expect(text).not.toMatch(/\/Users\/alice|super-secret-value/);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(root);
  });

  it("rejects symlinked evidence files instead of following repository aliases", async () => {
    const root = await fixture();
    await symlink(join(root, "README.md"), join(root, "DESIGN.md"));
    await expect(collectGovernanceEvidence({
      rootPath: root,
      projectId: "project-a",
      routes: ["/"],
      designDocuments: ["DESIGN.md"],
      componentDirectories: [],
    })).rejects.toThrow(/symbolic link/i);
  });
});
