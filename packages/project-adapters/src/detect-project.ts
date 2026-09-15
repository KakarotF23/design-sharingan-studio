import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { assertPathInsideWorkspace } from "./path-policy";
import { devCommandFor } from "./dev-launch";
import type {
  ProjectDetection,
  SupportedFramework,
  SupportedPackageManager,
} from "./types";

interface PackageJson {
  name?: unknown;
  packageManager?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

type PackageManagerDeclaration =
  | { kind: "ABSENT" }
  | { kind: "SUPPORTED"; value: SupportedPackageManager }
  | { kind: "UNSUPPORTED" };

const ROUTE_FILE_PATTERN = /\.(?:js|jsx|ts|tsx)$/;

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function hasGitMetadata(rootPath: string): Promise<boolean> {
  try {
    const entry = await lstat(join(rootPath, ".git"));
    return (
      !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile())
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function regularFileInsideWorkspace(
  rootPath: string,
  relativePath: string,
  label: string,
): Promise<string | undefined> {
  const candidatePath = join(rootPath, relativePath);
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(candidatePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  if (entry.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if (!entry.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }

  const canonicalPath = await realpath(candidatePath);
  return assertPathInsideWorkspace(rootPath, canonicalPath);
}

async function readPackageJson(rootPath: string): Promise<PackageJson | undefined> {
  const packagePath = await regularFileInsideWorkspace(
    rootPath,
    "package.json",
    "package.json",
  );
  if (packagePath === undefined) {
    return undefined;
  }

  const packageFile = await open(
    /* turbopackIgnore: true */ packagePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const entry = await packageFile.stat();
    if (!entry.isFile()) {
      throw new Error("package.json must be a regular file");
    }
    const parsed = JSON.parse(await packageFile.readFile("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("package.json must contain a JSON object");
    }
    return parsed as PackageJson;
  } finally {
    await packageFile.close();
  }
}

function declaredPackageManager(
  packageJson: PackageJson | undefined,
): PackageManagerDeclaration {
  if (
    packageJson === undefined ||
    !Object.prototype.hasOwnProperty.call(packageJson, "packageManager")
  ) {
    return { kind: "ABSENT" };
  }

  if (typeof packageJson.packageManager !== "string") {
    return { kind: "UNSUPPORTED" };
  }
  const match = /^(pnpm|yarn|npm)(?:@.+)?$/.exec(packageJson.packageManager);
  return match === null
    ? { kind: "UNSUPPORTED" }
    : {
        kind: "SUPPORTED",
        value: match[1] as SupportedPackageManager,
      };
}

async function detectPackageManager(
  rootPath: string,
  packageJson: PackageJson | undefined,
): Promise<SupportedPackageManager | undefined> {
  const lockfiles = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ] as const;
  const lockfileEvidence: SupportedPackageManager[] = [];
  for (const [lockfile, packageManager] of lockfiles) {
    if (
      (await regularFileInsideWorkspace(
        rootPath,
        lockfile,
        `${lockfile} lockfile`,
      )) !== undefined
    ) {
      lockfileEvidence.push(packageManager);
    }
  }
  if (lockfileEvidence.length > 1) {
    return undefined;
  }

  const declaration = declaredPackageManager(packageJson);
  if (declaration.kind === "UNSUPPORTED") {
    return undefined;
  }
  const [lockfilePackageManager] = lockfileEvidence;
  if (lockfilePackageManager !== undefined) {
    return declaration.kind === "SUPPORTED" &&
      declaration.value !== lockfilePackageManager
      ? undefined
      : lockfilePackageManager;
  }
  if (declaration.kind === "SUPPORTED") {
    return declaration.value;
  }
  return packageJson === undefined ? undefined : "pnpm";
}

async function detectFramework(
  rootPath: string,
  dependencies: Readonly<Record<string, string>>,
): Promise<SupportedFramework | undefined> {
  const hasNextSignature =
    "next" in dependencies ||
    (await Promise.all(
      ["next.config.js", "next.config.mjs", "next.config.ts"].map(
        async (file) =>
          (await regularFileInsideWorkspace(
            rootPath,
            file,
            `${file} framework configuration`,
          )) !== undefined,
      ),
    )).some(Boolean);
  if (hasNextSignature) {
    return "nextjs";
  }

  const hasViteSignature =
    "vite" in dependencies ||
    (await Promise.all(
      ["vite.config.js", "vite.config.mjs", "vite.config.ts"].map(
        async (file) =>
          (await regularFileInsideWorkspace(
            rootPath,
            file,
            `${file} framework configuration`,
          )) !== undefined,
      ),
    )).some(Boolean);
  if (hasViteSignature) {
    return "vite";
  }

  return "react" in dependencies ? "react" : undefined;
}

function isSafeKnownScript(
  script: string | undefined,
  signature: RegExp,
): boolean {
  if (
    script === undefined ||
    /[;&|`$<>\r\n]/.test(script) ||
    !signature.test(script.trim())
  ) {
    return false;
  }
  return true;
}

function commandForScript(
  packageManager: SupportedPackageManager,
  scriptName: "dev" | "start",
): string {
  return devCommandFor({ executable: packageManager, script: scriptName });
}

function detectDevCommand(
  framework: SupportedFramework | undefined,
  packageManager: SupportedPackageManager | undefined,
  scripts: Readonly<Record<string, string>>,
): string | undefined {
  if (framework === undefined || packageManager === undefined) {
    return undefined;
  }

  if (
    framework === "nextjs" &&
    isSafeKnownScript(scripts.dev, /^next\s+dev(?:\s+[^;&|`$<>]+)?$/)
  ) {
    return commandForScript(packageManager, "dev");
  }

  if (
    framework === "vite" &&
    isSafeKnownScript(scripts.dev, /^vite(?:\s+[^;&|`$<>]+)?$/)
  ) {
    return commandForScript(packageManager, "dev");
  }

  if (
    framework === "react" &&
    isSafeKnownScript(
      scripts.start,
      /^react-scripts\s+start(?:\s+[^;&|`$<>]+)?$/,
    )
  ) {
    return commandForScript(packageManager, "start");
  }

  return undefined;
}

async function walkRouteFiles(directoryPath: string): Promise<string[]> {
  if (!(await pathExists(directoryPath))) {
    return [];
  }
  const rootEntry = await lstat(directoryPath);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    return [];
  }

  const files: string[] = [];
  const pending = [directoryPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(entryPath);
      } else if (entry.isFile() && ROUTE_FILE_PATTERN.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function appRoute(appRoot: string, filePath: string): string | undefined {
  if (!/^page\.(?:js|jsx|ts|tsx)$/.test(basename(filePath))) {
    return undefined;
  }
  const segments = relative(appRoot, filePath).split(sep).slice(0, -1);
  const visibleSegments = segments.filter(
    (segment) =>
      !(segment.startsWith("(") && segment.endsWith(")")) &&
      !segment.startsWith("@"),
  );
  return visibleSegments.length === 0 ? "/" : `/${visibleSegments.join("/")}`;
}

function pagesRoute(pagesRoot: string, filePath: string): string | undefined {
  const relativeFile = relative(pagesRoot, filePath);
  const segments = relativeFile.split(sep);
  if (
    segments[0] === "api" ||
    ["_app", "_document", "_error"].some((name) =>
      new RegExp(`^${name}\\.(?:js|jsx|ts|tsx)$`).test(basename(filePath)),
    )
  ) {
    return undefined;
  }
  const routeSegments = segments;
  routeSegments[routeSegments.length - 1] = basename(filePath).replace(
    ROUTE_FILE_PATTERN,
    "",
  );
  if (routeSegments.at(-1) === "index") {
    routeSegments.pop();
  }
  return routeSegments.length === 0 ? "/" : `/${routeSegments.join("/")}`;
}

async function detectRoutes(rootPath: string): Promise<string[]> {
  const routes = new Set<string>();
  for (const appDirectory of ["app", join("src", "app")]) {
    const appRoot = join(/* turbopackIgnore: true */ rootPath, appDirectory);
    for (const filePath of await walkRouteFiles(appRoot)) {
      const route = appRoute(appRoot, filePath);
      if (route !== undefined) {
        routes.add(route);
      }
    }
  }
  for (const pagesDirectory of ["pages", join("src", "pages")]) {
    const pagesRoot = join(
      /* turbopackIgnore: true */ rootPath,
      pagesDirectory,
    );
    for (const filePath of await walkRouteFiles(pagesRoot)) {
      const route = pagesRoute(pagesRoot, filePath);
      if (route !== undefined) {
        routes.add(route);
      }
    }
  }
  return [...routes].sort();
}

async function existingRelativePaths(
  rootPath: string,
  candidates: readonly string[],
): Promise<string[]> {
  const results = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      exists: await pathExists(join(rootPath, candidate)),
    })),
  );
  return results.filter(({ exists }) => exists).map(({ candidate }) => candidate);
}

export async function detectProject(rootPath: string): Promise<ProjectDetection> {
  const canonicalRoot = await realpath(rootPath);

  // The sequence below is intentional and mirrors the intake contract.
  const packageJson = await readPackageJson(canonicalRoot);
  const packageManager = await detectPackageManager(canonicalRoot, packageJson);
  const dependencies = {
    ...stringRecord(packageJson?.dependencies),
    ...stringRecord(packageJson?.devDependencies),
  };
  const framework = await detectFramework(canonicalRoot, dependencies);
  const scripts = stringRecord(packageJson?.scripts);
  const devCommand = detectDevCommand(framework, packageManager, scripts);
  const renderTarget = framework === undefined ? undefined : "/";
  const routes = await detectRoutes(canonicalRoot);
  const componentDirectories = await existingRelativePaths(canonicalRoot, [
    "components",
    join("src", "components"),
  ]);
  const designDocuments = await existingRelativePaths(canonicalRoot, [
    "DESIGN.md",
    "README.md",
    "design-governance",
  ]);
  const hasGit = await hasGitMetadata(canonicalRoot);

  const [canReadFiles, canWriteFiles] = await Promise.all([
    access(canonicalRoot, constants.R_OK).then(
      () => true,
      () => false,
    ),
    access(canonicalRoot, constants.W_OK).then(
      () => true,
      () => false,
    ),
  ]);
  const canRender = devCommand !== undefined && renderTarget !== undefined;

  return {
    rootPath: canonicalRoot,
    name: typeof packageJson?.name === "string" ? packageJson.name : undefined,
    framework,
    packageManager,
    devCommand,
    renderTarget,
    scripts,
    routes,
    componentDirectories,
    designDocuments,
    hasGit,
    capabilities: {
      canReadFiles,
      canWriteFiles,
      canRun: devCommand !== undefined,
      canRender,
      canCapture: canRender,
      canUseGit: hasGit,
      canAudit: canReadFiles,
    },
  };
}
