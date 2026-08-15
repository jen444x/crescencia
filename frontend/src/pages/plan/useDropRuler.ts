import { useRef, useState } from "react";
import type { DragMoveEvent, DragStartEvent } from "@dnd-kit/core";
import { RETIME_PX_PER_MIN, snapRetime } from "./retime";
import { timeToMinutes } from "./dates";

// Giving a habit a time by dragging it into EMPTY space.
//
// Dropping a habit onto a block already works (dnd-kit hands us the block).
// This hook covers the other half: hold the habit where there is no block, and
// after a short dwell the RetimeRuler opens so you pick a real time off an hour
// grid — no block has to exist first, and there's no suggested time to correct.
//
// It only tracks the gesture; the page owns what a drop means. Two things make
// it work:
//   - the page's DndContext uses `pointerWithin`, so `over` is genuinely null
//     when the finger is outside every block (`closestCorners` always snapped
//     to the nearest one, and "over nothing" could never happen)
//   - the dwell timer does NOT restart on movement, only when the finger
//     crosses back over a block — a gutter is a small place to hold still, and
//     resetting on every jitter would make it unhittable
//
// The pointer→minute mapping is the SAME scale RetimeBlock uses, so a habit and
// a whole block feel identical to place.

// Fallback seed when the day has no timed blocks at all to sit between.
const EMPTY_DAY_SEED_MIN = 9 * 60;
// How long the habit has to sit over empty space before the ruler takes over.
const DWELL_MS = 400;
// Distance kept from a neighbouring block when seeding, so the ruler never
// opens already sitting on top of an existing time.
const SEED_GAP_MIN = 15;

// The drag's starting screen Y. dnd-kit reports movement as a delta from here,
// and the activator is a pointer, mouse, or touch event depending on the sensor.
function clientYOf(event: Event | null): number | null {
  if (!event) return null;
  if ("clientY" in event) return (event as PointerEvent).clientY;
  const touch =
    (event as TouchEvent).touches?.[0] ??
    (event as TouchEvent).changedTouches?.[0];
  return touch ? touch.clientY : null;
}

// What time does the ruler open on? Read the blocks' positions straight off the
// DOM (PlanSection stamps `data-chain-time`) and seed from the gap the finger is
// actually holding in — between 8:00 and 12:00 it opens near 10:00, below the
// last block an hour after it. So the ruler starts somewhere plausible and she
// drags a little, instead of starting at 9am and dragging across the day.
function seedMinuteAt(y: number): number {
  let prev: number | null = null;
  let next: number | null = null;
  for (const el of document.querySelectorAll<HTMLElement>("[data-chain-time]")) {
    const min = timeToMinutes(el.dataset.chainTime ?? "");
    if (!Number.isFinite(min)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= y) prev = min;
    else if (rect.top >= y && next == null) next = min;
  }

  let seed: number;
  if (prev != null && next != null) seed = Math.round((prev + next) / 2);
  else if (prev != null) seed = prev + 60;
  else if (next != null) seed = next - 60;
  else seed = EMPTY_DAY_SEED_MIN;

  const low = prev != null ? prev + SEED_GAP_MIN : 0;
  const high = next != null ? next - SEED_GAP_MIN : 24 * 60 - 1;
  return snapRetime(Math.max(low, Math.min(high, seed)));
}

export function useDropRuler() {
  // Set once the dwell fires: where the ruler is anchored on screen and the
  // minute pinned to that point. Null = the ruler isn't up.
  const [open, setOpen] = useState<{ anchorY: number; seedMin: number } | null>(
    null,
  );
  // The minute the habit would land on right now — drives the ruler's chip and
  // the drop.
  const [previewMin, setPreviewMin] = useState<number | null>(null);

  const startY = useRef<number | null>(null);
  const lastY = useRef<number | null>(null);
  const dwell = useRef<number | null>(null);

  function cancelDwell() {
    if (dwell.current != null) {
      window.clearTimeout(dwell.current);
      dwell.current = null;
    }
  }

  // Tear the ruler down. Called on drop, on cancel, and whenever the habit
  // crosses back over a real block.
  function reset() {
    cancelDwell();
    startY.current = null;
    lastY.current = null;
    setOpen(null);
    setPreviewMin(null);
  }

  function onDragStart(event: DragStartEvent) {
    reset();
    startY.current = clientYOf(event.activatorEvent);
    lastY.current = startY.current;
  }

  function onDragMove(event: DragMoveEvent) {
    if (startY.current == null) return;
    const y = startY.current + event.delta.y;
    lastY.current = y;

    // Back over a block: that block wins, and the ruler gets out of the way.
    if (event.over) {
      if (open || dwell.current != null) reset();
      return;
    }

    if (open) {
      // Down = later, up = earlier, snapped to the 15-minute grid the ruler draws.
      setPreviewMin(
        snapRetime(open.seedMin + (y - open.anchorY) / RETIME_PX_PER_MIN),
      );
      return;
    }

    // Over nothing and not yet counting — start the dwell. Deliberately not
    // restarted by later movement: it fires from wherever the finger has ended
    // up (lastY), so small drift while holding doesn't cancel it.
    if (dwell.current == null) {
      dwell.current = window.setTimeout(() => {
        dwell.current = null;
        const at = lastY.current;
        if (at == null) return;
        const seed = seedMinuteAt(at);
        setOpen({ anchorY: at, seedMin: seed });
        setPreviewMin(seed);
      }, DWELL_MS);
    }
  }

  return {
    // Is the ruler up? When it is, a drop means "make a new time", not "join a
    // block", and the page hides its own drag overlay in favour of the ruler's chip.
    isOpen: open != null,
    anchorY: open?.anchorY ?? 0,
    seedMin: open?.seedMin ?? 0,
    previewMin,
    onDragStart,
    onDragMove,
    reset,
  };
}
