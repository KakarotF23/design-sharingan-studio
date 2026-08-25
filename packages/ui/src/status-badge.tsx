import type { ReactNode } from "react";

export type StatusTone = "neutral" | "positive" | "attention" | "critical";

export interface StatusBadgeProps {
  children: ReactNode;
  tone?: StatusTone;
}

export function StatusBadge({
  children,
  tone = "neutral",
}: StatusBadgeProps) {
  return <span className={`ds-status ds-status--${tone}`}>{children}</span>;
}
