import type { SupportedFramework, SupportedPackageManager } from "./types";

/** The same bounded launch contract is used by detection and rendering. */
export interface DevLaunch {
  executable: SupportedPackageManager;
  script: "dev" | "start";
  framework?: SupportedFramework;
}
export type DevRuntimeBinary = "next" | "vite" | "react-scripts";

export function devCommandFor(launch: DevLaunch): string {
  return launch.executable === "npm" && launch.script === "dev" ? "npm run dev" : `${launch.executable} ${launch.script}`;
}

export function resolveDevLaunch(command: string | undefined, framework?: SupportedFramework): DevLaunch {
  const match = /^(pnpm|yarn|npm) (dev|start|run dev)$/.exec(command ?? "");
  if (!match || (match[2] === "run dev" && match[1] !== "npm") || (match[1] === "npm" && match[2] === "dev")) throw new Error("Project does not have a supported detected dev command");
  return { executable: match[1] as SupportedPackageManager, script: match[2] === "start" ? "start" : "dev", framework };
}

export function bindDevLaunch(launch: DevLaunch, endpoint: URL) {
  const port = endpoint.port || "80";
  const host = endpoint.hostname;
  const frameworkArgs = launch.framework === "vite" ? ["--host", host, "--port", port, "--strictPort"]
    : launch.framework === "nextjs" ? ["--hostname", host, "--port", port] : [];
  return {
    executable: launch.executable,
    requiredLocalBinary: (launch.framework === "nextjs" ? "next" : launch.framework === "vite" ? "vite" : launch.framework === "react" ? "react-scripts" : undefined) as DevRuntimeBinary | undefined,
    args: ["run", launch.script, ...(launch.executable === "npm" && frameworkArgs.length ? ["--"] : []), ...frameworkArgs],
    env: { PORT: port, HOST: host, BROWSER: "none" },
  };
}
