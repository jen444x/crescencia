import { useRef, useState } from "react";
import type { DragMoveEvent, DragStartEvent } from "@dnd-kit/core";
import { snapRetime } from "./retime";
import { timeToMinutes } from "./dates";

// The gesture half of the time rail. The rail itself is a faint line always down
// the left of the list (see TimeRail); this hook decides what a DRAG means.
//
// A drag has two zones, decided by where the finger sits HORIZONTALLY:
//   - over the list (right): the drag is about CHAINS — move up or down and the
//     habit joins whichever chain it's over. dnd-kit owns that; this stays out of
//     the way.
//   - on the rail (left): the drag is about TIME — the rail becomes an ordinary
//     ruler marked every 15 minutes and the habit rides it to a time.
//
// Why horizontal position and not the dwell timer this replaces: holding still
// over empty space was near-unhittable between two chains, and one stray pixel
// back over a chain tore the ruler down mid-choice. Moving onto the rail is
// deliberate, reversible, and can't be cancelled by jitter.
//
// Three details keep it solid:
//   - HYSTERESIS. Time mode opens at ENTER_X but only closes again at EXIT_X, so
//     a finger near the boundary can't strobe between the two modes.
//   - ARMING. The rail is narrow, so a card's grip sits close to ENTER_X and a
//     habit dragged straight down would slip onto it by accident. Time mode
//     needs a deliberate move: ARM_DX px LEFT of where the drag began, or a trip
//     out past EXIT_X first.
//   - SEEDING. The ruler opens on a time that suits where she already is — the
//     middle of the gap her finger is holding — so she nudges by a few minutes
//     instead of scrubbing across the day. It is NOT clamped to that gap: the
//     ruler runs continuously in both directions like any other ruler.

// 23:59 — the day's last valid minute.
const DAY_END_MIN = 23 * 60 + 59;

// Gesture zones, in px from the list's left edge.
const ENTER_X = 44;
const EXIT_X = 84;
// How far left of its start a drag must travel before the rail will take it.
const ARM_DX = 28;

// Holding the habit near the top or bottom edge keeps the ruler moving, the way
// dragging to the edge of a list keeps it scrolling.
//
// Without this the reachable times are only ever one screen of finger travel
// either side of where the ruler opened — and the page can't scroll to extend
// it, because scrolling mid-scrub is what used to slide the ruler out from under
// the finger. Grab a habit low on the page and you simply could not reach the
// morning: you had to drop it at the earliest time you could touch and drag it
// again. Sliding the ruler itself keeps the whole day reachable without moving
// the page at all.
const EDGE_PX = 90;
const EDGE_STEP_MIN = 15;
const EDGE_TICK_MS = 110;

// Ruler scale: 15 minutes = ~21px, so every mark is comfortably hittable.
export const RAIL_PX_PER_MIN = 1.4;
// Where the ruler opens when the day has no chains to sit between.
const EMPTY_DAY_SEED_MIN = 9 * 60;
// Kept clear of a neighbouring chain when seeding, so it never opens already
// sitting on an existing time.
const SEED_GAP_MIN = 15;

// The drag's starting screen point. dnd-kit reports movement as a delta from
// here, and the activator is a pointer, mouse, or touch event by sensor.
function pointOf(event: Event | null): { x: number; y: number } | null {
  if (!event) return null;
  if ("clientY" in event) {
    const pointer = event as PointerEvent;
    return { x: pointer.clientX, y: pointer.clientY };
  }
  const touch =
    (event as TouchEvent).touches?.[0] ??
    (event as TouchEvent).changedTouches?.[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
}

// Every timed chain on the day, read straight off the DOM (PlanSection stamps
// `data-chain-time`), with where each one sits on screen. Used to seed the ruler
// and to mark the existing chains on it.
function readChains(): { min: number; top: number; bottom: number }[] {
  const found: { min: number; top: number; bottom: number }[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("[data-chain-time]")) {
    const min = timeToMinutes(el.dataset.chainTime ?? "");
    if (!Number.isFinite(min)) continue;
    const rect = el.getBoundingClientRect();
    found.push({ min, top: rect.top, bottom: rect.bottom });
  }
  return found;
}

// What time does the ruler open on? The middle of the gap the finger is actually
// holding — between an 8:00 and a 12:00 chain it opens near 10:00, below the last
// chain an hour after it. So it starts somewhere plausible for where she is, and
// she nudges from there rather than scrubbing from 9am across the whole day.
function seedMinuteAt(y: number, chains: ReturnType<typeof readChains>): number {
  let prev: number | null = null;
  let next: number | null = null;
  for (const chain of chains) {
    if (chain.bottom <= y) prev = chain.min;
    else if (chain.top >= y && next == null) next = chain.min;
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

// The open ruler: the minute pinned to `anchorY` on screen, and the day's chains
// so they can be marked on it.
export type Ruler = {
  anchorY: number;
  seedMin: number;
  chainMins: number[];
};

export function useTimeRail() {
  // Set once time mode opens; null while the drag is still about chains.
  const [open, setOpen] = useState<Ruler | null>(null);
  // The minute the habit would land on right now — drives the ruler's marker,
  // the overlay card, and the drop.
  const [previewMin, setPreviewMin] = useState<number | null>(null);

  // onDragMove fires faster than React re-renders, so the handler reads these
  // refs rather than the state above (which would be a frame stale).
  const start = useRef<{ x: number; y: number } | null>(null);
  const left = useRef(0);
  const armed = useRef(false);
  const openRef = useRef<Ruler | null>(null);
  // The TRUE pointer position, straight off the window.
  //
  // dnd-kit's `event.delta` is deliberately not this: it folds in how far the
  // page has auto-scrolled, so it measures movement through the DOCUMENT. The
  // rail is drawn in viewport coordinates, so once a drag triggered any
  // auto-scroll the two diverged — the card read 11:15 AM while the ruler mark
  // under the finger said 8:15a. Reading clientX/clientY keeps the gesture in
  // the same space the rail draws in.
  const pointer = useRef<{ x: number; y: number } | null>(null);

  // One stable handler for the whole life of the hook. It has to be stable
  // because removeEventListener matches by identity — a handler rebuilt each
  // render could never be detached, so every drag would leave another listener
  // on the window. Seeded through useRef's initialiser (not assigned during
  // render), and it only ever writes to `pointer`, which is itself a ref.
  const trackRef = useRef<EventListener>((event: Event) => {
    const at = pointOf(event);
    if (at) pointer.current = at;
  });

  function listen(on: boolean) {
    const handler = trackRef.current;
    if (on) {
      window.addEventListener("pointermove", handler, { passive: true });
      window.addEventListener("touchmove", handler, { passive: true });
    } else {
      window.removeEventListener("pointermove", handler);
      window.removeEventListener("touchmove", handler);
    }
  }

  // The edge-advance timer, and which way it's currently running.
  const edge = useRef<number | null>(null);
  const edgeDir = useRef<0 | -1 | 1>(0);

  function stopEdge() {
    if (edge.current != null) window.clearInterval(edge.current);
    edge.current = null;
    edgeDir.current = 0;
  }

  // Keep sliding the ruler while the finger rests against an edge. Moving
  // `seedMin` shifts BOTH the pointer->minute mapping and the drawn marks, so
  // the ruler scrolls under a stationary finger and the time keeps changing.
  function runEdge(dir: -1 | 1) {
    if (edgeDir.current === dir) return; // already going this way
    stopEdge();
    edgeDir.current = dir;
    edge.current = window.setInterval(() => {
      const ruler = openRef.current;
      const at = pointer.current;
      if (!ruler || !at) return stopEdge();
      const seedMin = ruler.seedMin + dir * EDGE_STEP_MIN;
      // Stop at the ends of the day rather than grinding against the clamp.
      // One step of slack either side, so midnight and 23:45 are themselves
      // reachable (snapRetime clamps the last step onto the bound).
      const raw = seedMin + (at.y - ruler.anchorY) / RAIL_PX_PER_MIN;
      if (raw < -EDGE_STEP_MIN || raw > DAY_END_MIN + EDGE_STEP_MIN)
        return stopEdge();
      const moved: Ruler = { ...ruler, seedMin };
      openRef.current = moved;
      setOpen(moved);
      setPreviewMin(minuteAt(at.y, moved));
    }, EDGE_TICK_MS);
  }

  // Tear everything down. Called on drop and on cancel.
  function reset() {
    stopEdge();
    listen(false);
    start.current = null;
    pointer.current = null;
    armed.current = false;
    openRef.current = null;
    setOpen(null);
    setPreviewMin(null);
  }

  function onDragStart(event: DragStartEvent) {
    const list = document.querySelector<HTMLElement>("[data-plan-list]");
    left.current = list?.getBoundingClientRect().left ?? 0;
    start.current = pointOf(event.activatorEvent);
    pointer.current = start.current;
    armed.current = false;
    openRef.current = null;
    listen(true);
    setOpen(null);
    setPreviewMin(null);
  }

  function onDragMove(event: DragMoveEvent) {
    if (start.current == null) return;
    // Prefer the real pointer; fall back to dnd-kit's delta only if no pointer
    // event has landed yet (e.g. a keyboard-driven drag).
    const at = pointer.current;
    const x = at ? at.x : start.current.x + event.delta.x;
    const y = at ? at.y : start.current.y + event.delta.y;
    const relX = x - left.current;

    if (openRef.current != null) {
      // Already on the rail: it takes a move all the way back past EXIT_X to
      // hand the drag back to the chains.
      if (relX > EXIT_X) {
        stopEdge();
        openRef.current = null;
        setOpen(null);
        setPreviewMin(null);
        return;
      }
      // Down = later, up = earlier, on the ruler's own scale.
      setPreviewMin(minuteAt(y, openRef.current));
      // Against an edge? Keep the ruler moving so the rest of the day is
      // reachable without lifting the habit.
      const bottom = window.innerHeight - EDGE_PX;
      if (y < EDGE_PX) runEdge(-1);
      else if (y > bottom) runEdge(1);
      else stopEdge();
      return;
    }

    // See ARMING above.
    if (relX > EXIT_X || start.current.x - x >= ARM_DX) armed.current = true;
    if (!armed.current || relX >= ENTER_X) return;

    const chains = readChains();
    const next: Ruler = {
      anchorY: y,
      seedMin: seedMinuteAt(y, chains),
      chainMins: chains.map((c) => c.min),
    };
    openRef.current = next;
    setOpen(next);
    setPreviewMin(next.seedMin);
  }

  // Scrubbed onto a time that already HAS a chain? Then this drop means "add to
  // that chain", not "make a second chain at the same minute".
  const joinChainMin =
    open != null && previewMin != null && open.chainMins.includes(previewMin)
      ? previewMin
      : null;

  return {
    // Is this drag currently about TIME rather than chains? When it is, a drop
    // sets a time and the chain drop preview is suppressed.
    isTimeMode: open != null,
    // The open ruler, for it to draw.
    ruler: open,
    previewMin,
    // Non-null when the previewed time IS an existing chain's time.
    joinChainMin,
    onDragStart,
    onDragMove,
    reset,
  };
}

// Screen y -> the minute under it, snapped to the 15-minute grid the ruler draws.
export function minuteAt(y: number, r: Ruler): number {
  return snapRetime(r.seedMin + (y - r.anchorY) / RAIL_PX_PER_MIN);
}
