import type { Habit } from "./types";
// Which single habit moved in a within-chain reorder (fix #3). A single drag
// reorder relocates exactly one row; that row is the one whose removal from both
// the before- and after-lists leaves the remaining sequences identical. Returns
// its habit id, or null when the order didn't actually change (dropped in place).
export function movedHabitId(before: Habit[], after: Habit[]): number | null {
  if (before.length !== after.length) {
    // Lengths differ — not a pure reorder; can't pinpoint one moved row.
    return null;
  }
  const sameOrder = before.every((h, i) => h.id === after[i]?.id);
  if (sameOrder) return null;
  // Try each candidate: remove it from both lists; if the remainders match in
  // order, that candidate is the moved one.
  for (const cand of after) {
    const b = before.filter((h) => h.id !== cand.id);
    const a = after.filter((h) => h.id !== cand.id);
    if (b.length === a.length && b.every((h, i) => h.id === a[i].id)) {
      return cand.id;
    }
  }
  // Ambiguous (multiple rows shifted): default to the first row that changed
  // position, so we still write a single-habit generation rather than nothing.
  const i = after.findIndex((h, idx) => h.id !== before[idx]?.id);
  return i >= 0 ? after[i].id : null;
}
