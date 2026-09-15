import { createServer } from "node:net";
import { detectProject, type ProjectWorkspace } from "@design-sharingan/project-adapters";
import type { Project } from "@design-sharingan/core";
import { startDevServer } from "./dev-server";
export async function startProjectRenderSession(project: Project) {
  const detection = await detectProject(project.rootPath);
  const workspace: ProjectWorkspace = { ...project, ...detection, framework: detection.framework, packageManager: detection.packageManager };
  const port = await new Promise<number>((resolve, reject) => { const listener = createServer(); listener.once("error", reject); listener.listen(0, "127.0.0.1", () => { const address = listener.address(); if (address === null || typeof address === "string") { listener.close(); reject(new Error("Render port unavailable")); return; } listener.close(() => resolve(address.port)); }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = await startDevServer({ workspace, baseUrl, env: { RENDER_FIXTURE_PORT: String(port) }, timeoutMs: 30_000 });
  return { workspace, baseUrl, stop: () => server.stop() };
}
