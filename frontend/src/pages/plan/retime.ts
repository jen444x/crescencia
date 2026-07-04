// Retime a single chain (ephemeral time ruler): the ruler scale + snapping math
// shared by RetimeBlock (the pointer→time mapping) and RetimeRuler (the on-screen
// ruler), so both use the SAME px/min scale and the dragged chip tracks the finger.

// Ruler scale: ~1.1px per minute (≈66px/hour), so 15-min steps are ~16px — easy
// to hit. The SAME scale drives the pointer→time mapping and the on-screen ruler,
// so the dragged chip tracks your finger. Times snap to a loose 15-min grid.
export const RETIME_PX_PER_MIN = 1.1;
const RETIME_SNAP_MIN = 15;
export const RETIME_DRAG_THRESHOLD = 4; // px of movement before a press counts as a drag
const DAY_END_MIN = 23 * 60 + 59; // 23:59 — the day's last valid minute

// Round to the nearest 5 minutes, then clamp inside the day so a long drag stops
// at 00:00 / 23:59 instead of running off either end.
export function snapRetime(minutes: number): number {
  const snapped = Math.round(minutes / RETIME_SNAP_MIN) * RETIME_SNAP_MIN;
  return Math.max(0, Math.min(DAY_END_MIN, snapped));
}

// Keep two chains off the exact same minute — /plan/ renders same-time blocks as
// two stacked rows, which she didn't want. If `minutes` is already taken by
// another chain, step outward (just-after first, then just-before) to the nearest
// free minute so the dropped chain sorts beside its neighbor but stays its own
// block. Frontend owns this; the backend just stores whatever time we send.
export function avoidRetimeCollision(
  minutes: number,
  takenMinutes: number[],
): number {
  const taken = new Set(takenMinutes);
  if (!taken.has(minutes)) return minutes;
  for (let delta = 1; delta <= 60; delta++) {
    if (minutes + delta <= DAY_END_MIN && !taken.has(minutes + delta))
      return minutes + delta;
    if (minutes - delta >= 0 && !taken.has(minutes - delta))
      return minutes - delta;
  }
  return minutes; // every nearby minute taken (degenerate) — let it stack
}
