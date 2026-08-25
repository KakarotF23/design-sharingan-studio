"use client";

export type StudioMode = "SAFE" | "MANGEKYO";

export interface ModeSwitcherProps {
  mode: StudioMode;
  onChange?: (mode: StudioMode) => void;
}

export function ModeSwitcher({ mode, onChange }: ModeSwitcherProps) {
  return (
    <div className="ds-mode-switcher" role="group" aria-label="Execution mode">
      <button
        type="button"
        aria-pressed={mode === "SAFE"}
        onClick={() => onChange?.("SAFE")}
      >
        Safe
      </button>
      <button
        type="button"
        aria-pressed={mode === "MANGEKYO"}
        onClick={() => onChange?.("MANGEKYO")}
      >
        Mangekyō
      </button>
    </div>
  );
}
