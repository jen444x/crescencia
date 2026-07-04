import { createPortal } from "react-dom";
import { formatTime, minutesToHHMM } from "../dates";
import { RETIME_PX_PER_MIN } from "../retime";

// The ephemeral time ruler, shown only while a block is being dragged. A slim,
// translucent calendar surface: hour ticks + labels, cards for the day's other
// timed blocks (so you place this one relative to them), a dotted line at the
// block's original time, and the dragged block as a chip. Anchored so the
// block's start time sits at the press point (anchorY), at the same px/min as
// the pointer mapping — so the chip tracks your finger as it travels past the
// other chains. Portaled to <body> and pointer-events:none — the block's
// captured pointer handlers drive it; this is purely the visual.
export function RetimeRuler({
  anchorY,
  startMin,
  previewMin,
  blockLabel,
  otherBlocks,
}: {
  anchorY: number;
  startMin: number;
  previewMin: number;
  blockLabel: string;
  otherBlocks: { min: number; name: string }[];
}) {
  // Screen Y for a minute, anchored so startMin sits at the press point — the
  // chip then tracks your finger while the other chains stay put as context.
  const yForMin = (min: number) =>
    anchorY + (min - startMin) * RETIME_PX_PER_MIN;
  const viewportH = window.innerHeight;
  // The ruler runs past the viewport both ways; only draw what's on screen.
  const onScreen = (y: number) => y > -48 && y < viewportH + 48;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-50">
      {/* Dim the list so the ruler is the focus; both vanish on drop. */}
      <div className="absolute inset-0 bg-calm-900/30" />

      <div className="relative mx-auto h-full max-w-md overflow-hidden bg-white/60">
        <p className="absolute inset-x-0 top-0 z-10 bg-white/70 py-2 text-center text-[11px] font-medium uppercase tracking-wide text-calm-500">
          Drag to a time · release to set · today only
        </p>

        {/* Hour gridlines + labels. */}
        {Array.from({ length: 24 }, (_, h) => h).map((h) => {
          const y = yForMin(h * 60);
          if (!onScreen(y)) return null;
          return (
            <div
              key={`hour-${h}`}
              className="absolute inset-x-0 flex -translate-y-1/2 items-center gap-2 px-4"
              style={{ top: y }}
            >
              <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-calm-400">
                {formatTime(minutesToHHMM(h * 60))}
              </span>
              <span className="h-px flex-1 bg-calm-200" />
            </div>
          );
        })}

        {/* The day's other timed blocks, as light context markers. */}
        {otherBlocks.map((b) => {
          const y = yForMin(b.min);
          if (!onScreen(y)) return null;
          return (
            <div
              key={`${b.min}-${b.name}`}
              className="absolute inset-x-0 flex -translate-y-1/2 items-center px-4"
              style={{ top: y }}
            >
              <span className="ml-14 flex max-w-[70%] items-center gap-1.5 truncate rounded-lg bg-white px-2 py-1 text-[11px] text-calm-500 shadow-sm ring-1 ring-calm-200">
                <span className="shrink-0 tabular-nums text-calm-400">
                  {formatTime(minutesToHHMM(b.min))}
                </span>
                <span className="truncate">{b.name}</span>
              </span>
            </div>
          );
        })}

        {/* Dotted guide at the block's original time — drag back here to undo. */}
        {onScreen(yForMin(startMin)) && (
          <div
            className="absolute inset-x-0 -translate-y-1/2 px-4"
            style={{ top: yForMin(startMin) }}
          >
            <div className="ml-14 border-t border-dashed border-calm-300" />
          </div>
        )}

        {/* The dragged block itself, riding the ruler at its live time. */}
        <div
          className="absolute inset-x-0 -translate-y-1/2 px-4"
          style={{ top: yForMin(previewMin) }}
        >
          <div className="ml-12 flex items-center gap-2 rounded-xl bg-calm-600 px-3 py-2 text-white shadow-lg ring-2 ring-white">
            <span className="text-sm font-semibold tabular-nums">
              {formatTime(minutesToHHMM(previewMin))}
            </span>
            <span className="min-w-0 truncate text-xs text-calm-100">
              {blockLabel}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
