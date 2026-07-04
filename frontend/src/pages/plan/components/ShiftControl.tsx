import { useState, useEffect, useRef } from "react";
import { ClockIcon } from "../../../components/icons";

// The ⏱ "running late" control on a time block. Pushing this chain later moves
// it AND everything after it that day (the backend cascades + clamps); it's a
// per-day override, so the recurring routine is untouched. Deliberately separate
// from drag-reorder, which moves just one habit without changing times.
export function ShiftControl({
  chainId,
  onShift,
}: {
  chainId: number;
  onShift: (chainId: number, minutes: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(15);
  const ref = useRef<HTMLDivElement>(null);

  // Close the popover on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function apply(minutes: number) {
    if (!minutes) return;
    onShift(chainId, minutes);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Running late — shift this chain and everything after it"
        aria-expanded={open}
        className="flex h-6 w-6 items-center justify-center rounded-full text-calm-500 transition-colors hover:bg-calm-100 hover:text-calm-700"
      >
        <ClockIcon />
      </button>

      {open && (
        <div className="absolute right-0 top-7 z-50 w-60 rounded-xl border border-mist bg-white p-3 text-left shadow-lg">
          <p className="text-xs font-semibold text-calm-700">Running late?</p>
          <p className="mb-2 text-[11px] leading-snug text-stone-400">
            Moves this chain and everything after it — today only.
          </p>

          <div className="flex gap-1.5">
            {[15, 30, 45].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => apply(m)}
                className="flex-1 rounded-lg bg-calm-100 py-1.5 text-xs font-medium text-calm-700 transition-colors hover:bg-calm-200"
              >
                +{m}
              </button>
            ))}
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              value={custom}
              onChange={(e) =>
                setCustom(Math.max(1, parseInt(e.target.value, 10) || 0))
              }
              aria-label="Custom minutes"
              className="w-12 rounded-lg border border-mist px-2 py-1 text-xs text-calm-700"
            />
            <span className="text-[11px] text-stone-400">min</span>
            <button
              type="button"
              onClick={() => apply(-custom)}
              className="flex-1 rounded-lg border border-mist py-1 text-xs font-medium text-calm-600 transition-colors hover:bg-calm-50"
            >
              Earlier
            </button>
            <button
              type="button"
              onClick={() => apply(custom)}
              className="flex-1 rounded-lg border border-mist py-1 text-xs font-medium text-calm-600 transition-colors hover:bg-calm-50"
            >
              Later
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
