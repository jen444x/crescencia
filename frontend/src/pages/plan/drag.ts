import type { Chain, Habit } from "./types";

// Pure drag helpers for the plan board: parsing @dnd-kit's active/over ids into
// domain terms, and diffing habit order against a saved arrangement. No React, no
// fetches — given the ids + chains, they say what a drop means. The stateful drop
// handlers (optimistic move, persist, rollback) stay in the page.

// Parse a drag's ACTIVE id (the row being dragged). A timed row carries its numeric
// row_id; an Anytime habit that has no row yet carries "new-<habitId>".
export function parseActiveId(rawActive: string): {
  newHabitId: number | null;
  activeRid: number | null;
} {
  if (rawActive.startsWith("new-")) {
    return {
      newHabitId: Number(rawActive.slice("new-".length)),
      activeRid: null,
    };
  }
  return { newHabitId: null, activeRid: Number(rawActive) };
}

// Parse a drag's OVER id (where it's hovering / was dropped) into the row it landed
// on (`overRid`, null on a block's empty space) and the block it belongs to
// (`targetPlanId`, null = the Anytime group). Over ids: "plan-<id>"/"plan-anytime"
// = a block's empty space, "new-<id>" = an Anytime row, a bare number = a timed
// row's row_id (look up which block owns it). Shared by the live drag preview and
// the real drop so the two can never disagree.
export function parseDropTarget(
  rawOver: string,
  chains: Chain[],
): { overRid: number | null; targetPlanId: number | null } {
  if (rawOver.startsWith("plan-")) {
    const raw = rawOver.slice("plan-".length);
    return {
      overRid: null,
      targetPlanId: raw === "anytime" ? null : Number(raw),
    };
  }
  if (rawOver.startsWith("new-")) {
    return { overRid: null, targetPlanId: null }; // dropped onto an Anytime row
  }
  const overRid = Number(rawOver);
  const targetPlanId =
    chains.find(
      (p) => p.id != null && p.habits.some((h) => h.row_id === overRid),
    )?.id ?? null;
  return { overRid, targetPlanId };
}

// Has the day's habit order drifted from `baseline` (the order it loaded with)?
// Compares each timed block's habit-id sequence; the Anytime group is ignored (it
// has no schedule order). Drives whether the "Reset order" control shows.
export function orderChangedFrom(
  chains: Chain[],
  baseline: Chain[] | null,
): boolean {
  if (!baseline) return false;
  return chains.some((chain) => {
    if (chain.id == null) return false;
    const tpl = baseline.find((p) => p.id === chain.id);
    if (!tpl) return false;
    const now = chain.habits.map((h) => h.id);
    const was = tpl.habits.map((h) => h.id);
    return now.length !== was.length || now.some((id, i) => id !== was[i]);
  });
}

// Sort a block's CURRENT habits to match a template's habit-id order (keeping the
// live habit objects, so statuses/notes set since load aren't clobbered), and
// report whether that changed anything. Powers "Reset order" returning a block to
// a saved arrangement.
export function sortHabitsToTemplate(
  current: Habit[],
  templateHabitIds: number[],
): { reordered: Habit[]; changed: boolean } {
  const reordered = [...current].sort(
    (a, b) => templateHabitIds.indexOf(a.id) - templateHabitIds.indexOf(b.id),
  );
  const changed = reordered.some((h, i) => h.id !== current[i].id);
  return { reordered, changed };
}
