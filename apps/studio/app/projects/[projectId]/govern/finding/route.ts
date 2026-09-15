import { resolveGovernanceFinding, recordProjectPolishDebt } from "@design-sharingan/eternal-engine";
import { resolveProjectRequest } from "../../../../../features/projects/project-access";
import { readProjectJson } from "../../../../../features/projects/project-request";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try { return Response.json(await resolveGovernanceFinding(await resolveProjectRequest((await context.params).projectId), new URL(request.url).searchParams.get("finding") ?? "")); }
  catch { return Response.json({ error: "The current authenticated finding is unavailable." }, { status: 404 }); }
}
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const parsed = await readProjectJson(request); if (!parsed.ok) return parsed.response;
  const body = parsed.body as { findingKey?: unknown; rationale?: unknown } | null;
  if (!body || Object.keys(body).length !== 2 || typeof body.findingKey !== "string" || typeof body.rationale !== "string") return Response.json({ error: "Choose a polish finding and document the rationale." }, { status: 400 });
  try { await recordProjectPolishDebt(await resolveProjectRequest((await context.params).projectId), body.findingKey, body.rationale); return Response.json({ recorded: true }); }
  catch { return Response.json({ error: "This finding cannot be approved as non-blocking polish debt." }, { status: 422 }); }
}
