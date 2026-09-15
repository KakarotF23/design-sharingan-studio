import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function cannotResolve(candidatePath: string, cause?: unknown): Error {
  const error = new Error(
    `Cannot resolve whether path is outside active project workspace; refusing mutation: ${candidatePath}`,
  );
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function canonicalizeAllowingMissing(candidatePath: string): string {
  let existingAncestor = resolve(candidatePath);
  const missingSegments: string[] = [];

  while (true) {
    try {
      lstatSync(existingAncestor);

      try {
        return join(realpathSync.native(existingAncestor), ...missingSegments);
      } catch (error) {
        // An existing but unresolved entry (for example a dangling symlink) is
        // ambiguous and therefore unsafe to mutate through.
        throw cannotResolve(candidatePath, error);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        const parent = dirname(existingAncestor);
        if (parent === existingAncestor) {
          throw cannotResolve(candidatePath, error);
        }

        missingSegments.unshift(basename(existingAncestor));
        existingAncestor = parent;
        continue;
      }

      if (error instanceof Error && error.message.startsWith("Cannot resolve path")) {
        throw error;
      }
      throw cannotResolve(candidatePath, error);
    }
  }
}

/**
 * Resolve both paths through the real filesystem and return the canonical
 * candidate only when it is contained by the active project root.
 */
export function assertPathInsideWorkspace(
  rootPath: string,
  candidatePath: string,
): string {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(resolve(rootPath));
    if (!statSync(canonicalRoot).isDirectory()) {
      throw new Error("Workspace root is not a directory");
    }
  } catch (error) {
    throw cannotResolve(rootPath, error);
  }

  const absoluteCandidate = resolve(rootPath, candidatePath);
  const canonicalCandidate = canonicalizeAllowingMissing(absoluteCandidate);
  const relativeCandidate = relative(canonicalRoot, canonicalCandidate);
  const isOutside =
    isAbsolute(relativeCandidate) ||
    relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${sep}`);

  if (isOutside) {
    throw new Error(
      `Path is outside active project workspace: ${candidatePath}`,
    );
  }

  return canonicalCandidate;
}
