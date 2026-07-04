import {
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { formatTime, minutesToHHMM, timeToMinutes } from "../dates";
import {
  RETIME_PX_PER_MIN,
  RETIME_DRAG_THRESHOLD,
  snapRetime,
  avoidRetimeCollision,
} from "../retime";
import { RetimeRuler } from "./RetimeRuler";

// The retime gesture for a WHOLE timed chain. Grab the block by its header strip;
// past a small threshold the ephemeral RetimeRuler takes over and the block's
// position on it = its time, until you release. Grabbing the header (not the
// habit rows) leaves the within-block reorder + swipe-to-skip gestures untouched.
// `otherBlocks` give the ruler its context markers and break a same-minute tie on
// drop. Hand-rolled pointer events (like SwipeableCard), not dnd-kit.
export function RetimeBlock({
  chainId,
  time,
  blockLabel,
  otherBlocks,
  onRetime,
  header,
  children,
}: {
  chainId: number;
  time: string;
  blockLabel: string;
  otherBlocks: { min: number; name: string }[];
  onRetime: (chainId: number, time: string) => void;
  // The time-label row — becomes the grab handle. Anything inside it that must
  // stay tappable (e.g. the ⏰ shift button) carries data-no-retime.
  header: ReactNode;
  // The block's habit list (PlanBoard) — sits under the ruler while dragging, but
  // keeps its own gestures since the drag only ever starts on the header.
  children: ReactNode;
}) {
  const startY = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // The press point on screen, so the ruler can anchor the start time to it.
  const [anchorY, setAnchorY] = useState(0);
  // The minute the chain would land on right now (drives the chip + the save).
  const [previewMin, setPreviewMin] = useState<number | null>(null);

  // The block's current time in minutes. Derived from the `time` prop (stable
  // through a drag — no refetch happens until drop), so we never stash it in a
  // ref and read it during render.
  const startMin = timeToMinutes(time);

  function onPointerDown(e: ReactPointerEvent) {
    // A press on a control inside the header (the shift button) isn't a retime.
    if ((e.target as HTMLElement).closest("[data-no-retime]")) return;
    startY.current = e.clientY;
    setPreviewMin(startMin);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent) {
    if (startY.current == null) return;
    const delta = e.clientY - startY.current;
    // Ignore tiny movements so a stray tap on the header doesn't start a retime.
    if (!dragging && Math.abs(delta) < RETIME_DRAG_THRESHOLD) return;
    if (!dragging) {
      setDragging(true);
      setAnchorY(startY.current); // ruler anchors the start time to the press point
    }
    // Down = later, up = earlier — same scale the ruler draws, so the chip tracks
    // the finger. snapRetime rounds to the grid and clamps inside the day.
    setPreviewMin(snapRetime(startMin + delta / RETIME_PX_PER_MIN));
  }

  function onPointerUp() {
    const target = previewMin;
    const moved = dragging;
    startY.current = null;
    setDragging(false);
    setPreviewMin(null);
    // A press without a real drag, or a release back on the start time, writes
    // nothing. (Dropping on the recurring time clears the override — the backend
    // handles that "drag home" case, so we just send the absolute time.)
    if (!moved || target == null || target === startMin) return;
    const taken = otherBlocks.map((b) => b.min);
    onRetime(chainId, minutesToHHMM(avoidRetimeCollision(target, taken)));
  }

  // A cancelled gesture (e.g. the OS steals the pointer) must NOT commit a move.
  function onPointerCancel() {
    startY.current = null;
    setDragging(false);
    setPreviewMin(null);
  }

  return (
    <div className="relative">
      {/* The header strip is the grab handle — a big target. */}
      <div
        aria-label={`Set time for this chain — now ${formatTime(
          time,
        )}. Drag up or down on the ruler to set a new time.`}
        title="Drag up or down to set this chain's time (today only)"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className="cursor-grab touch-none select-none active:cursor-grabbing"
      >
        {header}
      </div>

      {children}

      {dragging && previewMin != null && (
        <RetimeRuler
          anchorY={anchorY}
          startMin={startMin}
          previewMin={previewMin}
          blockLabel={blockLabel}
          otherBlocks={otherBlocks}
        />
      )}
    </div>
  );
}
