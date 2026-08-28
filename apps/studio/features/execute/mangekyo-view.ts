import type { MangekyoLoopSession, Reference, RenderArtifact } from "@design-sharingan/core";
import type {
  MangekyoDataView,
  MangekyoRenderView,
  MangekyoSessionView,
} from "./mangekyo-types";

function renderView(render: RenderArtifact): MangekyoRenderView {
  return {
    id: render.id,
    route: render.route,
    viewport: render.viewport,
    capturedAt: render.capturedAt,
  };
}

function activity(session: MangekyoLoopSession): string {
  switch (session.status) {
    case "IDLE": return "Ready to begin the policy-bounded visual loop";
    case "PREPARING": return "Preparing the next visual objective";
    case "POLICY_CHECK": return "Checking the explicit autonomy policy before mutation";
    case "EDITING": return "Applying the authorized visual objective in an isolated mutation mirror";
    case "RUNNING": return "Running the project after the authorized mutation";
    case "CAPTURING": return "Capturing a fresh rendered artifact";
    case "COMPARING": return "Comparing authenticated reference and render images";
    case "DECIDING": return "Evaluating deterministic stop criteria";
    case "FIXING": return "One bounded visual objective remains";
    case "HUMAN_GATE": return "Human decision required before the pending policy-boundary mutation";
    case "COMPLETE": return "Visual loop complete with fresh final render evidence";
    case "BLOCKED": return "Visual loop stopped without a whole-product pass";
    case "FAILED": return "Visual loop stopped because project execution failed";
  }
}

function sessionView(session: MangekyoLoopSession): MangekyoSessionView {
  const latest = session.rounds.at(-1)?.round.afterRender ?? session.initialRender;
  return {
    id: session.id,
    status: session.status,
    currentRound: session.currentGate?.roundNumber ?? Math.min(session.rounds.length + 1, session.maxRounds),
    maxRounds: session.maxRounds,
    route: session.renderTarget.route,
    viewport: session.renderTarget.viewport.name,
    activity: activity(session),
    ...(session.initialRender === undefined ? {} : { initialRender: renderView(session.initialRender) }),
    ...(latest === undefined ? {} : { currentRender: renderView(latest) }),
    rounds: session.rounds.map(({ round }) => ({
      roundNumber: round.roundNumber,
      status: round.status,
      objective: round.actions[0] ?? "Inspect the rendered result",
      ...(round.afterRender === undefined ? {} : { afterRender: renderView(round.afterRender) }),
      findings: round.findingsAfter.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        category: finding.category,
        screen: finding.screen,
        description: finding.description,
        evidence: [...finding.evidence],
        reason: finding.reason,
        recommendedAction: finding.recommendedAction,
        status: finding.status,
      })),
      criticalCount: round.criticalCount,
      importantCount: round.importantCount,
      polishCount: round.polishCount,
      filesChanged: [...round.filesChanged],
      uxIntegrity: round.uxIntegrity.status,
      productConsistency: round.productConsistency.status,
      accessibility: round.accessibility.status,
      genomeIntegrity: round.genomeIntegrity.status,
    })),
    ...(session.currentGate === undefined ? {} : {
      currentGate: {
        id: session.currentGate.id,
        requestedChange: {
          kind: session.currentGate.requestedChange.kind,
          files: [...session.currentGate.requestedChange.files],
        },
        requestedChangeSummary: session.currentGate.proposal.summary,
        reasons: [...session.currentGate.reasons],
        affectedScope: [...session.currentGate.affectedScope],
        impact: session.currentGate.impact,
      },
    }),
    ...(session.stopReason === undefined ? {} : { stopReason: session.stopReason }),
  };
}

export function mangekyoDataView(
  references: readonly Reference[],
  session?: MangekyoLoopSession,
): MangekyoDataView {
  return {
    references: references.map(({ id, title }) => ({ id, title })),
    ...(session === undefined ? {} : { session: sessionView(session) }),
  };
}
