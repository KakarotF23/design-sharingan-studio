import { StatusBadge } from "@design-sharingan/ui";
import type { StudioProjectState } from "./project-state";

export function ProjectStatus({ status }: Pick<StudioProjectState, "status">) {
  const ready = status === "READY";
  return (
    <StatusBadge tone={ready ? "positive" : "attention"}>
      {ready ? "Ready" : "Needs configuration"}
    </StatusBadge>
  );
}
