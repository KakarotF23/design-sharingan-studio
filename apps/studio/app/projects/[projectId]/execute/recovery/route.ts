import { inspectMutationRecovery, reconcileMutationRecovery } from "@design-sharingan/approval-engine";
import { detectProject, recoverInterruptedSafeExecution } from "@design-sharingan/project-adapters";
import { captureWorkspaceSourceRevision } from "@design-sharingan/render-engine";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { readProjectJson } from "../../../../../features/projects/project-request";
export const runtime = "nodejs";

async function contextFor(projectId: string) {
  const project = await resolveProjectRequest(projectId);
  const session = await recoverInterruptedSafeExecution(project.rootPath, project.id, () => inspectMutationRecovery(project.rootPath));
  if (session.status !== "APPROVED" || session.executionFailure?.targetDisposition !== "RECONCILIATION_REQUIRED") throw new Error("No interrupted mutation is selected");
  const detection = await detectProject(project.rootPath);
  const workspace = { ...project, ...detection, framework: detection.framework, packageManager: detection.packageManager };
  const sourceFingerprint = async () => {
    const source = await captureWorkspaceSourceRevision(workspace);
    if (!source.available) throw new Error("Current target bytes cannot be verified");
    return source.worktreeFingerprint;
  };
  return { project, session, sourceFingerprint };
}
export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { project, session, sourceFingerprint } = await contextFor((await context.params).projectId);
    const recovery = await inspectMutationRecovery(project.rootPath);
    if (recovery && recovery.proposalId !== session.proposal.id) throw new Error("Recovery does not match the selected approval");
    return Response.json({ recovery: recovery ? { ...recovery, sourceFingerprint: await sourceFingerprint(), affectedPaths: session.executionFailure!.affectedPaths } : null });
  } catch { return Response.json({ error: "Authenticated recovery evidence is unavailable." }, { status: 409 }); }
}
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const parsed = await readProjectJson(request); if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown> | null;
  if (!body || Array.isArray(body) || Object.keys(body).sort().join(",") !== "claimId,confirmation,expectedSourceFingerprint,proposalId" || typeof body.claimId !== "string" || typeof body.proposalId !== "string" || typeof body.expectedSourceFingerprint !== "string" || body.confirmation !== "KEEP_CURRENT_FILES") return Response.json({ error: "Explicitly confirm the reviewed target files." }, { status: 400 });
  try {
    const { project, session, sourceFingerprint } = await contextFor((await context.params).projectId);
    if (body.proposalId !== session.proposal.id) throw new Error("Wrong approval");
    await reconcileMutationRecovery(project.rootPath, { claimId: body.claimId, proposalId: body.proposalId, expectedSourceFingerprint: body.expectedSourceFingerprint, confirmation: body.confirmation }, sourceFingerprint);
    return Response.json({ recovered: true });
  } catch { return Response.json({ error: "Recovery was not applied. Reinspect the files; an active or changed owner cannot be cleared." }, { status: 409 }); }
}
