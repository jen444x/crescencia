// Helpers for the "Apply to future days" PLACEMENT writer (Phase 2 / fix #3).
//
// The toggle-OFF path writes the per-day layer (`/days/arrange/`, keyed on
// row_id) — unchanged. The toggle-ON path writes a DATED recurring Schedule
// generation via `/schedules/arrange-forward/`, which identifies a slot by
// habit + tier (NOT a row_id) and sends an ABSOLUTE order.
//
// SCOPE (fix #3): moving ONE habit forward must change ONLY that habit's forward
// placement. It must NOT rewrite the other habits in the affected cycle(s), and
// it must not disturb anything an earlier toggle-OFF edit set on a frozen day.
// So the forward payload carries exactly ONE item — the moved habit's new slot —
// and `arrange_forward` upserts only that habit's dated generation. Every other
// habit keeps whatever forward placement it already had.
//
// Placement only — time / status / routine-tag edits are out of scope here.

import type { Plan, Habit } from "./types";

// One item in the arrange-forward body: a slot identified by habit + tier, at
// an absolute order, in a given cycle (plan: null = Anytime).
export type ForwardItem = {
  habit: number;
  plan: number | null;
  tier: number | null;
  order: number;
  routine: number | null;
};

// The "sensible order at the drop position" the spec asks for: the moved habit's
// 1-based index in the target cycle's post-move habit list. We deliberately do
// NOT renumber the siblings (that would be a whole-cycle rewrite); the moved
// habit simply takes the order of the slot it landed in. The generation-aware
// read then sorts the cycle by (order, id), so the moved habit slots in at that
// position among the siblings' existing orders.
//
// `targetPlan` is the cycle AFTER the optimistic move (so it already contains the
// moved habit). `routine` is forced null on a cross-cycle move (a routine is a
// same-block tag); pass the habit's own routine for an in-place reorder.
export function forwardItemForMove(
  movedHabit: Habit,
  targetPlanId: number | null,
  targetHabitsAfterMove: Habit[],
  routine: number | null,
): ForwardItem {
  const idx = targetHabitsAfterMove.findIndex((h) => h.id === movedHabit.id);
  const order = (idx >= 0 ? idx : targetHabitsAfterMove.length - 1) + 1;
  return {
    habit: movedHabit.id,
    plan: targetPlanId,
    tier: movedHabit.tier ?? null,
    order,
    routine,
  };
}

// Read the single moved habit's forward item off the OPTIMISTIC post-move plans.
// `habitId` is the moved habit; `targetPlanId` is the cycle it now lives in
// (null = Anytime). Returns null if the habit can't be found in that cycle (the
// caller then skips the write). Routine defaults to whatever the habit carries
// in the optimistic state — callers that move across cycles set it to null there.
export function forwardItemForPlan(
  plans: Plan[],
  habitId: number,
  targetPlanId: number | null,
): ForwardItem | null {
  const plan = plans.find((p) => p.id === targetPlanId);
  if (!plan) return null;
  const moved = plan.habits.find((h) => h.id === habitId);
  if (!moved) return null;
  return forwardItemForMove(moved, targetPlanId, plan.habits, moved.routine ?? null);
}
