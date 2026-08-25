"use client";

export type StudioMode = "SAFE" | "MANGEKYO";

export interface ModeSwitcherProps {
  mode: StudioMode;
  onChange?: (mode: StudioMode) => void;
}

export function ModeSwitcher({ mode, onChange }: ModeSwitcherProps) {
  return (
    <div className="ds-mode-switcher">
      <div role="group" aria-label="Execution mode">
        <button
          type="button"
          aria-pressed={mode === "SAFE"}
          onClick={() => onChange?.("SAFE")}
        >
          Safe
        </button>
        <button
          type="button"
          aria-pressed={false}
          aria-describedby="ds-mangekyo-unavailable"
          disabled
        >
          Mangekyō
        </button>
      </div>
      <span id="ds-mangekyo-unavailable" className="ds-mode-switcher__note">
        Mangekyō becomes available after its policy engine is implemented.
      </span>
    </div>
  );
}
