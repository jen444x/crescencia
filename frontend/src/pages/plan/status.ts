import type { Habit, HabitStatus, ReadStatus, Chain } from "./types";
import { highestDoneLevel, isCaseB, levelsUpTo, versionForLevel } from "./tier";

// Read a habit's state, tolerating an older payload that only had done_today.
export function isDone(habit: Habit) {
  return habit.status ? habit.status === "COMPLETED" : !!habit.done_today;
}
export function isSkipped(habit: Habit) {
  return habit.status === "SKIPPED";
}

// Return a NEW plans array with one habit's status set. With a `version` (rung id)
// it sets that ONE rung's status (and, on a completion, cascades DOWN to mark the
// lower rungs done); without one it sets the whole-habit status. Pure + immutable,
// so React reliably re-renders.
export function applyStatus(
  chains: Chain[],
  habitId: number,
  status: HabitStatus,
  version?: number,
): Chain[] {
  return chains.map((chain) => ({
    ...chain,
    habits: chain.habits.map((habit) => {
      if (habit.id !== habitId) return habit;
      if (version == null) {
        return { ...habit, status, done_today: status === "COMPLETED" };
      }
      // The completed rung's ladder position, so the cascade knows which rungs
      // are "below" it (completing a higher win marks the lower rungs done).
      const level = (habit.tiers ?? []).find((t) => t.version === version)?.level;
      const tiers = (habit.tiers ?? []).map((t) => {
        if (t.version === version)
          return { ...t, status, done: status === "COMPLETED" };
        if (status === "COMPLETED" && level != null && t.level < level)
          return { ...t, status: "COMPLETED" as ReadStatus, done: true };
        return t;
      });
      return { ...habit, tiers };
    }),
  }));
}

// Apply a tap-menu choice to one habit slot, preserving the tier cascade:
// completing a Case-B rung marks the easier ones done too (so Clear can step DOWN
// a rung); Clear on a done card uncompletes the highest done rung. Shared by the
// active card (dot + menu) and the completed-tray row so they behave identically.
type StatusAction = "COMPLETE" | "SKIP" | "MISS" | "CLEAR";
export function applyStatusAction(
  habit: Habit,
  tierToSend: number | undefined, // a ladder LEVEL; translated to a version id below
  action: StatusAction,
  isDone: boolean,
  onStatus: (habitId: number, status: HabitStatus, version?: number) => void,
) {
  const v = (level: number | undefined) => versionForLevel(habit, level);
  if (action === "COMPLETE") {
    if (isCaseB(habit) && tierToSend != null) {
      for (const lvl of levelsUpTo(habit, tierToSend))
        onStatus(habit.id, "COMPLETED", v(lvl));
    } else {
      onStatus(habit.id, "COMPLETED", v(tierToSend));
    }
  } else if (action === "SKIP") {
    onStatus(habit.id, "SKIPPED", v(tierToSend));
  } else if (action === "MISS") {
    onStatus(habit.id, "MISSED", v(tierToSend));
  } else {
    // CLEAR -> back to pending. A done card steps DOWN from its highest done rung.
    const top =
      isDone && isCaseB(habit)
        ? (highestDoneLevel(habit) ?? tierToSend)
        : tierToSend;
    onStatus(habit.id, "PENDING", v(top));
  }
}
