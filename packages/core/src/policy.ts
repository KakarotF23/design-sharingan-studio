export type AutonomyChangeKind =
  | "STYLE_CHANGE"
  | "COMPONENT_REFACTOR"
  | "PRESENTATIONAL_COMPONENT"
  | "DEPENDENCY_INSTALL"
  | "NAVIGATION_CHANGE"
  | "DATA_MODEL_CHANGE"
  | "FILE_DELETION";

export interface AutonomyPolicy {
  allowStyleChanges: boolean;
  allowSmallComponentRefactors: boolean;
  maxFilesForComponentRefactor: number;
  allowNewPresentationalComponents: boolean;
  allowDependencyInstall: boolean;
  allowNavigationChanges: boolean;
  allowDataModelChanges: boolean;
  allowFileDeletion: boolean;
  protectedPaths: readonly string[];
}

export interface AutonomyChange {
  kind: AutonomyChangeKind;
  files: readonly string[];
}

export interface AutonomyPolicyEvaluation {
  decision: "ALLOW" | "HUMAN_GATE";
  reasons: string[];
}

export const DEFAULT_AUTONOMY_POLICY: AutonomyPolicy = {
  allowStyleChanges: true,
  allowSmallComponentRefactors: true,
  maxFilesForComponentRefactor: 3,
  allowNewPresentationalComponents: true,
  allowDependencyInstall: false,
  allowNavigationChanges: false,
  allowDataModelChanges: false,
  allowFileDeletion: false,
  protectedPaths: []
};

function pathMatchesPattern(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const expression = normalizedPattern
    .split("/")
    .map((segment) => {
      if (segment === "**") {
        return ".*";
      }

      return segment.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", "[^/]*");
    })
    .join("/");

  return new RegExp(`^${expression}$`).test(normalizedPath);
}

function isAllowed(policy: AutonomyPolicy, change: AutonomyChange): boolean {
  switch (change.kind) {
    case "STYLE_CHANGE":
      return policy.allowStyleChanges;
    case "COMPONENT_REFACTOR":
      return (
        policy.allowSmallComponentRefactors &&
        change.files.length <= policy.maxFilesForComponentRefactor
      );
    case "PRESENTATIONAL_COMPONENT":
      return policy.allowNewPresentationalComponents;
    case "DEPENDENCY_INSTALL":
      return policy.allowDependencyInstall;
    case "NAVIGATION_CHANGE":
      return policy.allowNavigationChanges;
    case "DATA_MODEL_CHANGE":
      return policy.allowDataModelChanges;
    case "FILE_DELETION":
      return policy.allowFileDeletion;
  }
}

export function evaluateAutonomyPolicy(
  policy: AutonomyPolicy,
  change: AutonomyChange
): AutonomyPolicyEvaluation {
  const protectedFiles = change.files.filter((file) =>
    policy.protectedPaths.some((pattern) => pathMatchesPattern(file, pattern))
  );

  if (protectedFiles.length > 0) {
    return {
      decision: "HUMAN_GATE",
      reasons: protectedFiles.map((file) => `Protected path: ${file}`)
    };
  }

  if (isAllowed(policy, change)) {
    return { decision: "ALLOW", reasons: [] };
  }

  return {
    decision: "HUMAN_GATE",
    reasons: [`${change.kind} exceeds the approved autonomy policy.`]
  };
}
