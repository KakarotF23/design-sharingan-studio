import type { AutonomyChange, ChangeProposal } from "@design-sharingan/core";

const HIGH_RISK_DECLARATIONS = [
  "FILE_DELETION",
  "DATA_MODEL_CHANGE",
  "NAVIGATION_CHANGE",
  "DEPENDENCY_INSTALL",
] as const;

export function classifyProposalChange(proposal: ChangeProposal): AutonomyChange {
  const files = [
    ...proposal.filesToCreate,
    ...proposal.filesToModify,
    ...proposal.filesToDelete,
  ];
  if (proposal.filesToDelete.length > 0) return { kind: "FILE_DELETION", files };
  if (
    files.some((path) =>
      /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/.test(path),
    )
  ) {
    return { kind: "DEPENDENCY_INSTALL", files };
  }
  const declaredHighRisk = HIGH_RISK_DECLARATIONS.find((kind) =>
    proposal.policyViolations.includes(kind),
  );
  if (declaredHighRisk !== undefined) return { kind: declaredHighRisk, files };
  if (
    files.length > 0 &&
    files.every((path) => /\.(?:css|scss|sass|less)$/.test(path))
  ) {
    return { kind: "STYLE_CHANGE", files };
  }
  // Code semantics cannot be authenticated from proposal prose alone. Treat
  // every ambiguous code change as navigation-sensitive so the policy enters
  // HUMAN_GATE instead of trusting a model-supplied low-risk label.
  return { kind: "NAVIGATION_CHANGE", files };
}
