"use client";

export type StudioMode = "SAFE" | "MANGEKYO";

export interface ModeSwitcherProps {
  mode: StudioMode;
  onChange?: (mode: StudioMode) => void;
  mangekyoDisabled?: boolean;
}

export function ModeSwitcher({
  mode,
  onChange,
  mangekyoDisabled = onChange === undefined,
}: ModeSwitcherProps) {
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
          aria-pressed={mode === "MANGEKYO"}
          aria-describedby={mangekyoDisabled ? "ds-mangekyo-unavailable" : undefined}
          disabled={mangekyoDisabled}
          onClick={() => onChange?.("MANGEKYO")}
        >
          Mangekyō
        </button>
      </div>
      {mangekyoDisabled ? (
        <span id="ds-mangekyo-unavailable" className="ds-mode-switcher__note">
          Mangekyō becomes available after its policy engine and an approved Safe Mode mutation are ready.
        </span>
      ) : null}
    </div>
  );
}
