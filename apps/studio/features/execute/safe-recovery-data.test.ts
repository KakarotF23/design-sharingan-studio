import { expect, it, vi } from "vitest";

const { claim, plain, interrupted } = vi.hoisted(() => {
  const plain = { id: "safe-1", status: "APPROVED", proposal: { id: "proposal-1" } };
  return { plain, interrupted: { ...plain, executionFailure: { targetDisposition: "RECONCILIATION_REQUIRED", affectedPaths: ["src/page.tsx"] } }, claim: { claimId: "a".repeat(64), proposalId: "proposal-1", phase: "APPLYING", ownerState: "ABANDONED" } };
});
vi.mock("@design-sharingan/project-adapters", () => ({
  loadSafeExecutionState: async () => plain,
  detectProject: async () => ({}),
  recoverInterruptedSafeExecution: async (root: string, projectId: string, inspect: () => Promise<unknown>) => {
    expect(root).toBe("/canonical/project"); expect(projectId).toBe("project-1");
    expect(await inspect()).toEqual(claim);
    return interrupted;
  },
}));
vi.mock("@design-sharingan/approval-engine", () => ({ inspectMutationRecovery: async (root: string) => { expect(root).toBe("/canonical/project"); return claim; }, reconcileMutationRecovery: vi.fn() }));
vi.mock("@design-sharingan/render-engine", () => ({ captureWorkspaceSourceRevision: async () => ({ available: true, worktreeFingerprint: "b".repeat(64) }) }));
vi.mock("../projects/project-access", () => ({ resolveProjectRequest: async () => ({ id: "project-1", rootPath: "/canonical/project" }) }));
import { GET as readExecution } from "../../app/projects/[projectId]/execute/data/route";
import { GET as readRecovery } from "../../app/projects/[projectId]/execute/recovery/route";
const context = () => ({ params: Promise.resolve({ projectId: "project-1" }) });

// Production break caught: the execution reader bypasses authenticated hard-crash recovery and leaves the UI polling an ownerless APPROVED checkpoint forever.
it("routes the execution reader through authenticated interrupted-approval recovery", async () => {
  const response = await readExecution(new Request("http://localhost/execute/data"), context());
  expect(response.status).toBe(200);
  expect((await response.json()).executeSession).toEqual(interrupted);
});

// Production break caught: direct recovery inspection requires an error-handler checkpoint that cannot exist after a hard process death.
it("exposes the exact abandoned claim even when the pre-recovery session has no failure checkpoint", async () => {
  const response = await readRecovery(new Request("http://localhost/execute/recovery"), context());
  expect(response.status).toBe(200);
  expect((await response.json()).recovery).toMatchObject({ ...claim, affectedPaths: ["src/page.tsx"], sourceFingerprint: "b".repeat(64) });
});
