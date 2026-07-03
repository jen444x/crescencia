import type { Chain, Habit, Segment } from "./types";
import { timeToMinutes } from "./dates";
import { isUntiered } from "./tier";
import { isDone } from "./status";

// Which time block is happening right now? The latest block whose start time has
// already passed (at 9:10, the "9:00 AM" block is current). Before the day's
// first block, fall back to it so the page still opens somewhere sensible.
// Returns the plan id to scroll to, or null if there are no timed blocks.
export function currentBlockId(chains: Chain[]): number | null {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let currentId: number | null = null;
  let currentMinutes = -1;
  let earliestId: number | null = null;
  let earliestMinutes = Infinity;

  for (const chain of chains) {
    if (chain.id == null || !chain.time) continue;
    const minutes = timeToMinutes(chain.time);
    if (minutes <= nowMinutes && minutes > currentMinutes) {
      currentMinutes = minutes;
      currentId = chain.id;
    }
    if (minutes < earliestMinutes) {
      earliestMinutes = minutes;
      earliestId = chain.id;
    }
  }
  return currentId ?? earliestId;
}

// Row + Segment types now live in ./plan/types. buildSegments turns a plan's
// habits into the ordered segments a time block renders (active rows, collapsed
// "done" runs, and in-place routine blocks).
export function buildSegments(habits: Habit[], asChain: boolean): Segment[] {
  // 1) Collapse into ordered "units": consecutive habits sharing a routine
  //    become one routine unit; every other habit is its own unit.
  type Unit =
    | { type: "habit"; habit: Habit }
    | { type: "routine"; routineId: number; name: string; habits: Habit[] };
  const units: Unit[] = [];
  for (const habit of habits) {
    const last = units[units.length - 1];
    if (habit.routine != null) {
      if (last && last.type === "routine" && last.routineId === habit.routine) {
        last.habits.push(habit);
      } else {
        units.push({
          type: "routine",
          routineId: habit.routine,
          name: habit.routine_name ?? "Routine",
          habits: [habit],
        });
      }
    } else {
      units.push({ type: "habit", habit });
    }
  }

  // 2) Step numbers come from the TIME BLOCK itself: every timed block is one
  //    chain, so its units are steps 1..N in order (a routine counts as one
  //    step). A block with a single unit is a "chain of one" — shown plain, no
  //    number. "Anytime" isn't a time, so it's never a chain (asChain false) and
  //    its habits stay loose.
  const numbered = asChain && units.length >= 2;
  const stepNumbers = units.map((_, i) => (numbered ? i + 1 : null));

  // 3) Emit segments in order, grouping consecutive completed single habits into
  //    one "done" chip. Routine units never collapse.
  const segments: Segment[] = [];
  let run: Habit[] = [];
  const flushRun = () => {
    if (run.length > 0) {
      segments.push({ kind: "done", key: `done-${run[0].id}`, habits: run });
      run = [];
    }
  };

  units.forEach((u, i) => {
    const next = units[i + 1];
    // Connect down to the next step in the block, unless that step is a collapsed
    // done habit (so the connector line never dangles into the done tray).
    const connectBelow =
      numbered &&
      next != null &&
      // A tiered done card isn't collapsed (it stays a visible step), so only a
      // COLLAPSED (untiered) done habit should break the connector line.
      !(next.type === "habit" && isDone(next.habit) && isUntiered(next.habit));

    if (u.type === "routine") {
      flushRun();
      segments.push({
        kind: "routine",
        key: `routine-${u.routineId}-${u.habits[0].id}`,
        routineId: u.routineId,
        name: u.name,
        stepNumber: stepNumbers[i],
        connectBelow,
        habits: u.habits,
      });
      return;
    }

    // Only plain (untiered) completions collapse into the "✓ N done" tray. A
    // tiered slot stays a full card when done, so it still shows its version value
    // (e.g. "· 5am") and its check uncompletes THAT version — the tray can't carry
    // a tier, which made completed tiers flip between two cards confusingly.
    if (isDone(u.habit) && isUntiered(u.habit)) {
      run.push(u.habit);
      return;
    }
    flushRun();
    segments.push({
      kind: "active",
      row: { habit: u.habit, stepNumber: stepNumbers[i], connectBelow },
    });
  });
  flushRun();

  return segments;
}

// Return a NEW plans array with one plan's habits set to `orderedHabits`,
// renumbered 1..N. Pure + immutable, like applyStatus above.
export function applyPlanOrder(
  chains: Chain[],
  chainId: number,
  orderedHabits: Habit[],
): Chain[] {
  return chains.map((chain) =>
    chain.id === chainId
      ? {
          ...chain,
          habits: orderedHabits.map((habit, i) => ({ ...habit, order: i + 1 })),
        }
      : chain,
  );
}
