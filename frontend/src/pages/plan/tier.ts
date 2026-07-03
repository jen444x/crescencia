import type { Habit, SlotPlacement, ReadStatus } from "./types";

// The day-tier levels. Roots = the hard/minimum day; Growth = the everyday bar.
// Levels match the backend's tier levels.
export const ROOTS_LEVEL = 1;
export const GROWTH_LEVEL = 2;

// The selectable day-tiers, in display order. The toolbar's tier picker maps over
// THIS list instead of hardcoding buttons, so adding a future tier is a one-line
// change here — every consumer below already compares levels numerically.
export const DAY_TIERS: { level: number; name: string }[] = [
  { level: ROOTS_LEVEL, name: "Roots" },
  { level: GROWTH_LEVEL, name: "Growth" },
];

// True when a row carries no tiers at all — a plain habit that renders and
// completes exactly as it always has (no tier label, no tier sent).
export function isUntiered(habit: Habit): boolean {
  return habit.tier == null && (habit.tiers?.length ?? 0) === 0;
}

// Case B: a single same-time slot (tier null) that still carries the habit's
// ladder, so ONE row shows the rung for today and we synthesize stretch cards for
// the harder rungs. (Untiered habits are tier null too, hence the tiers check.)
export function isCaseB(habit: Habit): boolean {
  return habit.tier == null && (habit.tiers?.length ?? 0) > 0;
}

// Case B's "today" rung: the highest tier level <= dayTier, or null if the habit
// has no rung at/below today (then its inline row is dropped — it only stretches).
export function caseBInlineLevel(habit: Habit, dayTier: number): number | null {
  const at = (habit.tiers ?? [])
    .map((t) => t.level)
    .filter((lvl) => lvl <= dayTier);
  return at.length ? Math.max(...at) : null;
}

// The value to print after a row's name (the lighter "· 5 min" span), per case:
//   Case A: this slot's own value (tier_value, or look it up in tiers by level).
//   Case B: the value of the highest rung <= dayTier (its "today" version).
//   untiered: none.
export function rowDisplayValue(habit: Habit, dayTier: number): string | null {
  if (habit.tier != null) {
    if (habit.tier_value) return habit.tier_value;
    return habit.tiers?.find((t) => t.level === habit.tier)?.value ?? null;
  }
  if (isCaseB(habit)) {
    const level = caseBInlineLevel(habit, dayTier);
    if (level == null) return null;
    return habit.tiers?.find((t) => t.level === level)?.value ?? null;
  }
  return null;
}

// The tier level a row's complete button should send (undefined = send none):
//   Case A: this slot's tier.
//   Case B inline: the highest rung <= dayTier.
//   untiered: undefined.
export function rowCompleteTier(
  habit: Habit,
  dayTier: number,
): number | undefined {
  if (habit.tier != null) return habit.tier;
  if (isCaseB(habit)) return caseBInlineLevel(habit, dayTier) ?? undefined;
  return undefined;
}

// Where a slot renders for the chosen day-tier. inlineTierByHabit maps a habit id
// to the highest Case-A slot level <= dayTier (its "today version"), or null.
//   untiered -> always inline.
//   Case A   -> inline at its habit's highest tier <= today; stretch if harder than
//               today; otherwise hidden (a lower, cascade-covered rung).
//   Case B   -> inline when it has a rung <= today (one row for the day); plus
//               separate synthesized stretch cards for its harder rungs (built at
//               the page level, not here). With no rung <= today it isn't inline.
export function slotPlacement(
  habit: Habit,
  inlineTierByHabit: Map<number, number | null>,
  dayTier: number,
): SlotPlacement {
  if (isUntiered(habit)) return "inline"; // untiered slot, always shown
  if (isCaseB(habit))
    return caseBInlineLevel(habit, dayTier) != null ? "inline" : "stretch";
  const inline = inlineTierByHabit.get(habit.id) ?? null;
  if (habit.tier === inline) return "inline"; // the highest tier <= today
  if ((habit.tier ?? 0) > dayTier) return "stretch"; // harder than today -> bottom
  return "hidden"; // lower, cascade-covered
}

// The status to show on ONE tier-slot card: its own version's per-tier status
// (the backend already folded in the higher-completes-lower cascade), so
// completing the easy version never changes the harder card and vice versa. An
// untiered card — or an older payload without per-tier status — falls back to
// the whole-habit status / done_today.
export function slotStatus(
  habit: Habit,
  level: number | undefined,
): ReadStatus {
  if (level != null) {
    const t = habit.tiers?.find((tt) => tt.level === level);
    if (t?.status) return t.status;
  }
  return habit.status ?? (habit.done_today ? "COMPLETED" : "PENDING");
}

// TODAY's highest rung that reads DONE (`tiers[].done`, which already folds in the
// higher-completes-lower cascade), or null if none. Drives a Case-B card's "show
// your highest achievement" display, the step-down undo, and which stretch rungs
// are already covered.
export function highestDoneLevel(habit: Habit): number | null {
  const done = (habit.tiers ?? []).filter((t) => t.done).map((t) => t.level);
  return done.length ? Math.max(...done) : null;
}

// Every rung at or BELOW `level`, ascending. Completing a rung marks these all
// done (you can't have hit the harder version without the easier), so the
// step-down undo has real rungs to land on instead of dropping straight to open.
export function levelsUpTo(habit: Habit, level: number): number[] {
  return (habit.tiers ?? [])
    .map((t) => t.level)
    .filter((lvl) => lvl <= level)
    .sort((a, b) => a - b);
}

// The rung a Case-B inline card should SHOW/act on: your highest achievement when
// it's at least today's rung (so once Growth is done it reads "· 12:30am"), else
// today's target rung. null only when the habit has no rung at/below today.
export function caseBDisplayLevel(
  habit: Habit,
  dayTier: number,
): number | null {
  const today = caseBInlineLevel(habit, dayTier);
  const done = highestDoneLevel(habit);
  if (done != null && (today == null || done >= today)) return done;
  return today;
}
