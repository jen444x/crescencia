import type { Chain, Habit, SlotPlacement, ReadStatus } from "./types";

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

// The ladder position the day-toggle points AT for this habit. The toggle picks a
// TAG (Roots/Growth); this finds the rung wearing that tag and returns its level,
// so "today's bar" is the labeled rung — untagged rungs in between sit above or
// below it and fall out as stretch/covered. Plain 2-rung habits (Roots=level 1,
// Growth=level 2) map straight back to the old `dayTier` number. If the habit has
// no rung with that tag, fall back to its top rung so nothing is hidden.
export function effectiveDayLevel(habit: Habit, dayTier: number): number {
  const rungs = habit.tiers ?? [];
  const tagged = rungs.find((t) => t.label === dayTier);
  if (tagged) return tagged.level;
  const levels = rungs.map((t) => t.level);
  return levels.length ? Math.max(...levels) : dayTier;
}

// The rung id (Version.id) at a given ladder level — what a completion sends over
// the wire. undefined when there's no such rung (or an untiered/whole-habit act).
export function versionForLevel(
  habit: Habit,
  level: number | undefined,
): number | undefined {
  if (level == null) return undefined;
  return habit.tiers?.find((t) => t.level === level)?.version;
}

// Chip classes for a rung's tag: Roots wears clay-on-blush, Growth leaf-on-mint,
// an untagged rung a quiet neutral. Keyed on the tag level, not the ladder level.
export function tagChipClasses(label: number | null | undefined): string {
  if (label === ROOTS_LEVEL) return "bg-blush text-clay";
  if (label === GROWTH_LEVEL) return "bg-mint text-calm-700";
  return "bg-calm-50 text-calm-400";
}

// "07:30" -> "7:30am", "14:00" -> "2pm" — the compact clock the app's values
// already use, so derived goals read like the hand-typed ones.
function fmtClock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${ap}` : `${h12}${ap}`;
}

// A rung's TYPED goal as plain prose — "by 7:30am", "for 5 min", or "by 7:30am
// for 5 min" — reading as a natural continuation of the habit's name ("Wake up
// by 7:30am"). "" when the rung has no typed fields.
export function typedGoal(
  t?: {
    target_time?: string | null;
    duration?: string | null;
  } | null,
): string {
  if (!t) return "";
  const parts: string[] = [];
  if (t.target_time) parts.push(`by ${fmtClock(t.target_time)}`);
  // Free text now ("10 mins", "one song"), so it's printed as typed — the unit
  // is hers to write, not ours to append.
  if (t.duration?.trim()) parts.push(`for ${t.duration.trim()}`);
  return parts.join(" ");
}

// A rung's AMOUNT — the free-text "how much" — which reads in FRONT of the
// habit's name ("2000 steps Walk", "3 pages Read"), the way you'd say it out
// loud. The typed goals trail the name instead ("... by 7:30am for 10 mins"),
// so a fully filled rung reads "2000 steps Walk by 7:30am for 10 mins".
export function rungAmount(
  t?: {
    value?: string | null;
  } | null,
): string {
  return t?.value?.trim() ?? "";
}

// A rung's goal as display text: the typed fields when it has them, else the
// free-text value. This is what makes a habit created as just name + Complete
// by still SHOW its goal — its value is "" there, so the row would read bare.
export function rungGoal(
  t?: {
    value?: string | null;
    target_time?: string | null;
    duration?: string | null;
  } | null,
): string {
  if (!t) return "";
  return typedGoal(t) || (t.value ?? "");
}

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
  const eff = effectiveDayLevel(habit, dayTier);
  const at = (habit.tiers ?? [])
    .map((t) => t.level)
    .filter((lvl) => lvl <= eff);
  return at.length ? Math.max(...at) : null;
}

// The value to print after a row's name (the lighter "· 5 min" span), per case:
//   Case A: this slot's own value (tier_value, or look it up in tiers by level).
//   Case B: the value of the highest rung <= dayTier (its "today" version).
//   untiered: none.
export function rowDisplayValue(habit: Habit, dayTier: number): string | null {
  if (habit.tier != null) {
    const rung = habit.tiers?.find((t) => t.level === habit.tier);
    return rungGoal(rung) || habit.tier_value || null;
  }
  if (isCaseB(habit)) {
    const level = caseBInlineLevel(habit, dayTier);
    if (level == null) return null;
    return rungGoal(habit.tiers?.find((t) => t.level === level)) || null;
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

// habit id -> the highest Case-A tier-slot level (h.tier, the non-null ones)
// that is <= dayTier, or null when none qualify. This picks which of a habit's
// several tier-slots is its "today" version: the one that renders inline, while
// lower slots are cascade-hidden and higher ones stretch. Untiered + Case-B
// rows aren't in here (they carry no per-slot tier); slotPlacement handles them.
export function computeInlineTierByHabit(
  chains: Chain[],
  dayTier: number,
): Map<number, number | null> {
  const byHabit = new Map<number, number[]>();
  for (const chain of chains)
    for (const h of chain.habits)
      if (h.tier != null) {
        const a = byHabit.get(h.id) ?? [];
        a.push(h.tier);
        byHabit.set(h.id, a);
      }
  const inline = new Map<number, number | null>();
  for (const [hid, tiers] of byHabit) {
    const ok = tiers.filter((t) => t <= dayTier);
    inline.set(hid, ok.length ? Math.max(...ok) : null);
  }
  return inline;
}

// The day's tally for the plant meter (wilting/steady/flourishing). Reads each
// habit's status the SAME way its card does — via slotStatus on the row's shown
// rung — so a completed/missed TIERED habit (whose status lives in habit.tiers,
// not habit.status) moves the plant immediately, not only after a reload. Pass
// the ALREADY-filtered chains (shownChains) so it mirrors the cards on screen
// (day-tier + "Main only"). Purely derived; nothing is stored.
export function computePlanTotals(
  chains: Chain[],
  dayTier: number,
): { done: number; missed: number; total: number } {
  let done = 0;
  let missed = 0;
  let total = 0;
  for (const chain of chains) {
    for (const h of chain.habits) {
      const level = isCaseB(h)
        ? (caseBDisplayLevel(h, dayTier) ?? undefined)
        : rowCompleteTier(h, dayTier);
      const st = slotStatus(h, level);
      total++;
      if (st === "COMPLETED") done++;
      else if (st === "MISSED") missed++;
    }
  }
  return { done, missed, total };
}

// The "Stretch" section entries: harder versions she can opt into, in plan order.
// Two sources: (1) Case-A slots that placed as "stretch" (a tier above today at
// its own time), each completed at its own `tier`; (2) synthesized entries for
// every Case-B rung ABOVE what the inline card already shows (above the highest
// DONE rung, else above today), each completed at that rung's level. `level` is
// the tier each card shows + sends. `mainOnly` drops helper/support habits.
export function computeStretchSlots(
  chains: Chain[],
  inlineTierByHabit: Map<number, number | null>,
  dayTier: number,
  mainOnly: boolean,
): { habit: Habit; level: number }[] {
  const out: { habit: Habit; level: number }[] = [];
  for (const chain of chains) {
    for (const habit of chain.habits) {
      if (mainOnly && habit.is_support) continue;
      if (habit.tier != null) {
        // Case A: this slot stretches when it's a harder tier than today.
        if (slotPlacement(habit, inlineTierByHabit, dayTier) === "stretch")
          out.push({ habit, level: habit.tier });
      } else if (isCaseB(habit)) {
        // Case B: one synthesized "do more" card per rung above what the inline
        // card already shows — above the highest DONE rung (so a completed harder
        // rung isn't also listed as a stretch), or above today when nothing's done.
        const done = highestDoneLevel(habit);
        const eff = effectiveDayLevel(habit, dayTier);
        const covered = done != null ? Math.max(eff, done) : eff;
        for (const t of habit.tiers ?? [])
          if (t.level > covered) out.push({ habit, level: t.level });
      }
    }
  }
  return out;
}
