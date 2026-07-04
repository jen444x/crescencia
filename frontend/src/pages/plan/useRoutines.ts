import { useState } from "react";
import { useToast } from "../../components/Toast";
import { toYMD } from "./dates";
import { forwardItemForMove } from "./forward";
import { chainLabel } from "./chains";
import type { Chain, Habit, HabitStatus } from "./types";

// Which routine sheet is open: "create" for a new one, "edit" (+id/name) to
// manage an existing one, or null when closed.
type RoutineSheetState =
  | { mode: "create" }
  | { mode: "edit"; id: number; name: string }
  | null;

// All Plan-page routine logic in one place: the create/edit sheet state and the
// create / save / delete / move / status-log handlers. These re-fetch the day
// (via triggerReload) rather than optimistic-updating, so the hook receives the
// page's shared infrastructure instead of owning it:
//  - chainsRef: the live plans (moveRoutineToChain reads them for the move math)
//  - viewedDate / isViewingToday: today-vs-other-day API payloads
//  - triggerReload: bump the page's reloadToken to re-pull /plan/
export function useRoutines({
  chainsRef,
  viewedDate,
  isViewingToday,
  triggerReload,
}: {
  chainsRef: { current: Chain[] };
  viewedDate: Date;
  isViewingToday: boolean;
  triggerReload: () => void;
}) {
  const toast = useToast();
  const [routineSheet, setRoutineSheet] = useState<RoutineSheetState>(null);

  async function setRoutineStatus(routineId: number, status: HabitStatus) {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/${routineId}/log/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isViewingToday ? { status } : { status, date: toYMD(viewedDate) },
          ),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      triggerReload();
    } catch {
      toast("Couldn't update the routine", { variant: "error" });
    }
  }

  // Create a routine from the sheet (name + the habits checked in it). Re-fetch
  // so the new block appears. Returns true so the sheet can close on success.
  async function createRoutine(
    name: string,
    scheduleIds: number[],
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/create/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, schedules: scheduleIds }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      triggerReload();
      toast(`Created "${name}"`, { variant: "success" });
      return true;
    } catch {
      toast("Couldn't create the routine", { variant: "error" });
      return false;
    }
  }

  // Save edits from the sheet: rename, then apply membership changes (the sheet
  // diffs checked-vs-current into add/remove). We skip the members call when
  // nothing moved, since the endpoint requires a non-empty change.
  async function saveRoutine(
    routineId: number,
    name: string,
    addIds: number[],
    removeIds: number[],
  ): Promise<boolean> {
    try {
      const editRes = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/${routineId}/edit/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      if (!editRes.ok) throw new Error("Request failed");

      if (addIds.length > 0 || removeIds.length > 0) {
        const memRes = await fetch(
          `${import.meta.env.VITE_API_URL}/routines/${routineId}/members/`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ add: addIds, remove: removeIds }),
          },
        );
        if (!memRes.ok) throw new Error("Request failed");
      }
      triggerReload();
      return true;
    } catch {
      toast("Couldn't save the routine", { variant: "error" });
      return false;
    }
  }

  // Delete a routine — its habits are ungrouped (SET_NULL), not deleted. Close
  // the sheet and re-fetch.
  async function deleteRoutine(routineId: number) {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/${routineId}/delete/`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      if (!res.ok) throw new Error("Request failed");
      setRoutineSheet(null);
      triggerReload();
      toast("Routine deleted", { variant: "info" });
    } catch {
      toast("Couldn't delete the routine", { variant: "error" });
    }
  }

  // Move a whole routine (all its member habits) into another chain, PERMANENTLY
  // from today — the menu twin of dragging a habit across blocks. Drag can't pick
  // up a routine (it stays put inside its chain by design), so this is how a
  // routine relocates. We KEEP the routine tag (the members stay grouped) and
  // reuse the forward writer, so the move lands every day from today AND is
  // mirrored into a frozen today (arrange_forward's reflect-today) instead of
  // silently skipping the day you're looking at. Members append to the bottom of
  // the target chain with consecutive orders, so the block lands in one piece.
  //
  // `memberScheduleIds` (from the sheet's Save) pins the members to the routine's
  // SAVED membership, so an add/remove made in the same Save is honored. When it's
  // omitted (the Undo path), we fall back to the current routine tag.
  async function moveRoutineToChain(
    routineId: number,
    targetPlanId: number,
    memberScheduleIds?: number[],
  ): Promise<boolean> {
    const current = chainsRef.current;
    const allHabits = current.flatMap((p) => p.habits);
    const members = memberScheduleIds
      ? memberScheduleIds
          .map((sid) => allHabits.find((h) => h.schedule_id === sid))
          .filter((h): h is Habit => h != null)
      : allHabits.filter((h) => h.routine === routineId);
    if (members.length === 0) return false;

    const sourcePlan = current.find(
      (p) => p.id != null && p.habits.some((h) => members.includes(h)),
    );
    const targetPlan = current.find((p) => p.id === targetPlanId);
    if (!targetPlan || targetPlan.id == null) return false;
    if (sourcePlan?.id === targetPlanId) return true; // already there — no-op

    // The target chain AFTER the move: its current habits + the routine members
    // appended (still tagged). forwardItemForMove numbers each member by its
    // index here, so they take consecutive orders at the bottom and read as one
    // block. We send ONLY the moved members; the per-slot forward read drops
    // their old-chain generation automatically, so they leave the source chain.
    const targetAfter = [...targetPlan.habits, ...members];
    const items = members.map((m) =>
      forwardItemForMove(m, targetPlanId, targetAfter, routineId),
    );

    const routineName =
      members.find((m) => m.routine_name)?.routine_name ?? "routine";
    const destLabel =
      targetPlan.name || chainLabel(targetPlan.habits, targetPlan.time);

    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/schedules/arrange-forward/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from_date: toYMD(new Date()), items }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      triggerReload();
      const backTo = sourcePlan?.id ?? null;
      toast(
        `Moved "${routineName}" to ${destLabel}`,
        backTo != null
          ? {
              action: {
                label: "Undo",
                onClick: () => void moveRoutineToChain(routineId, backTo),
              },
            }
          : undefined,
      );
      return true;
    } catch {
      toast("Couldn't move the routine", { variant: "error" });
      return false;
    }
  }

  return {
    routineSheet,
    setRoutineSheet,
    setRoutineStatus,
    createRoutine,
    saveRoutine,
    deleteRoutine,
    moveRoutineToChain,
  };
}
