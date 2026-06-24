// Helpers for the "Apply to future days" PLACEMENT writer (Phase 2).
//
// The toggle-OFF path writes the per-day layer (`/days/arrange/`, keyed on
// row_id) — unchanged. The toggle-ON path writes a DATED recurring Schedule
// generation via `/schedules/arrange-forward/`, which identifies a slot by
// habit + tier (NOT a row_id) and always sends an ABSOLUTE order. The contract
// wants the WHOLE affected cycle(s) sent fresh as 1..N (idempotent), with
// plan:null meaning Anytime / no cycle.
//
// These functions take the already-computed OPTIMISTIC plans (the post-move
// state the per-day path would also produce) and turn the affected cycles into
// that absolute item list. Placement only — time / status / routine-tag edits
// are out of scope here.

import type { Plan } from "./types";

// One item in the arrange-forward body: a slot identified by habit + tier, at
// an absolute order, in a given cycle (plan: null = Anytime).
export type ForwardItem = {
  habit: number;
  plan: number | null;
  tier: number | null;
  order: number;
  routine: number | null;
};

// Turn ONE cycle's habits into fresh 1..N forward items. `planId` is the cycle
// the rows now live in (null for Anytime). Order follows the habits array's
// current order — the caller passes the optimistic, post-move order.
export function forwardItemsForPlan(
  planId: number | null,
  habits: Plan["habits"],
): ForwardItem[] {
  return habits.map((habit, i) => ({
    habit: habit.id,
    plan: planId,
    tier: habit.tier ?? null,
    order: i + 1,
    routine: habit.routine ?? null,
  }));
}

// Build the full arrange-forward items list for a set of affected cycles, read
// off the optimistic plans. `affectedPlanIds` lists the cycle ids whose whole
// contents must be re-sent (use null for the Anytime group). Every listed
// cycle's rows are emitted fresh 1..N so the generation is rewritten wholesale.
export function buildForwardItems(
  plans: Plan[],
  affectedPlanIds: Array<number | null>,
): ForwardItem[] {
  const items: ForwardItem[] = [];
  for (const planId of affectedPlanIds) {
    const plan = plans.find((p) => p.id === planId);
    if (!plan) continue;
    items.push(...forwardItemsForPlan(planId, plan.habits));
  }
  return items;
}
