import { isAbsolute } from "node:path";

export const PROJECT_LOCATOR_COOKIE = "design-sharingan-project";

interface ProjectLocator {
  version: 1;
  rootPath: string;
}

export function encodeProjectLocator(rootPath: string): string {
  const locator: ProjectLocator = { version: 1, rootPath };
  return Buffer.from(JSON.stringify(locator), "utf8").toString("base64url");
}

export function decodeProjectLocator(value: string): string | undefined {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return undefined;
  }

  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return undefined;
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const locator = parsed as Partial<ProjectLocator>;
    if (
      locator.version !== 1 ||
      typeof locator.rootPath !== "string" ||
      locator.rootPath.length === 0 ||
      locator.rootPath.length > 2048 ||
      locator.rootPath.includes("\0") ||
      !isAbsolute(locator.rootPath)
    ) {
      return undefined;
    }
    return locator.rootPath;
  } catch {
    return undefined;
  }
}
