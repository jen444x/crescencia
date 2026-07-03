import type { Habit, HabitStatus, ReadStatus, Chain } from "./types";

// Read a habit's state, tolerating an older payload that only had done_today.
export function isDone(habit: Habit) {
  return habit.status ? habit.status === "COMPLETED" : !!habit.done_today;
}
export function isSkipped(habit: Habit) {
  return habit.status === "SKIPPED";
}

// Return a NEW plans array with one habit's status set. With a `tier` it sets
// that ONE version's status (and, on a completion, cascades DOWN to mark the
// lower rungs done); without one it sets the whole-habit status. Pure +
// immutable, so React reliably re-renders.
export function applyStatus(
  chains: Chain[],
  habitId: number,
  status: HabitStatus,
  tier?: number,
): Chain[] {
  return chains.map((chain) => ({
    ...chain,
    habits: chain.habits.map((habit) => {
      if (habit.id !== habitId) return habit;
      if (tier == null) {
        return { ...habit, status, done_today: status === "COMPLETED" };
      }
      // Per-version: update this rung. A completion cascades down (a higher win
      // marks the lower rungs done); skip/missed touch only this rung. An undo's
      // full de-cascade is reconciled by a refetch in setHabitStatus.
      const tiers = (habit.tiers ?? []).map((t) => {
        if (t.level === tier)
          return { ...t, status, done: status === "COMPLETED" };
        if (status === "COMPLETED" && t.level < tier)
          return { ...t, status: "COMPLETED" as ReadStatus, done: true };
        return t;
      });
      return { ...habit, tiers };
    }),
  }));
}
