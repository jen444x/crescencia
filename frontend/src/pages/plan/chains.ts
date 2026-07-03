import type { Habit } from "./types";
import { formatTime } from "./dates";

// A short label for a whole chain: its first habit, plus "+N" when it holds more
// (so a multi-habit block reads as more than just its first item). Falls back to
// the time if a block somehow has no habits.
export function chainLabel(habits: Habit[], time: string | null): string {
  const first = habits[0]?.name;
  if (!first) return formatTime(time);
  return habits.length > 1 ? `${first} +${habits.length - 1}` : first;
}
