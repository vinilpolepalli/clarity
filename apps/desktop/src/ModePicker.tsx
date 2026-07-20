import { useEffect, useRef } from "react";
import { Check, Grid2X2, Settings } from "lucide-react";
import type { ModeModel } from "./bridge";

interface ModePickerProps {
  anchorElement: HTMLElement | null;
  model: ModeModel;
  placement: "above" | "below";
  viewportHeight: number;
  error: string;
  onClose: () => void;
  onManage: () => void;
  onSelect: (modeId: string) => void;
}

export function ModePicker({ anchorElement, model, placement, viewportHeight, error, onClose, onManage, onSelect }: ModePickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = pickerRef.current?.querySelector<HTMLButtonElement>(`[data-mode-id="${CSS.escape(model.activeModeId)}"]`);
    active?.focus();
  }, [model.activeModeId]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!pickerRef.current?.contains(target) && !anchorElement?.contains(target)) onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [anchorElement, onClose]);

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>, direction: -1 | 1) {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-mode-id]")];
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  return (
    <div
      ref={pickerRef}
      className="overlay-mode-picker"
      data-placement={placement}
      style={{ height: viewportHeight }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(event, 1); }
        if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(event, -1); }
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
      }}
    >
      <div className="overlay-mode-list" role="listbox" aria-label="Assistant mode">
        {model.modes.map((mode) => (
          <button
            key={mode.id}
            type="button"
            role="option"
            aria-selected={mode.id === model.activeModeId}
            data-mode-id={mode.id}
            onClick={() => onSelect(mode.id)}
          >
            <Grid2X2 size={13} />
            <span>{mode.label}</span>
            {mode.id === model.activeModeId && <Check size={15} />}
          </button>
        ))}
      </div>
      {error && <p className="overlay-mode-error" role="alert">{error}</p>}
      <button className="overlay-mode-manage" type="button" onClick={onManage}><Settings size={14} /><span>Manage</span></button>
    </div>
  );
}
