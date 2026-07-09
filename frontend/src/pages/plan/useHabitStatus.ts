import { type Dispatch, type SetStateAction } from "react";
import { applyStatus } from "./status";
import { toYMD } from "./dates";
import type { Chain, HabitStatus } from "./types";

// Setting a habit's status for the viewed day (complete / skip / miss / clear) —
// the plan page's core interaction, and the direct twin of setRoutineStatus in
// useRoutines. Optimistic: update the UI first so it feels instant, POST the log,
// and restore the snapshot if the request fails (so the UI never lies). The page
// owns chains + reloadToken and injects them, matching the other plan hooks.
export function useHabitStatus({
  chainsRef,
  setChains,
  isViewingToday,
  viewedDate,
  triggerReload,
}: {
  chainsRef: { current: Chain[] };
  setChains: Dispatch<SetStateAction<Chain[]>>;
  isViewingToday: boolean;
  viewedDate: Date;
  triggerReload: () => void;
}) {
  async function setHabitStatus(
    habitId: number,
    status: HabitStatus,
    version?: number,
  ) {
    const snapshot = chainsRef.current;
    setChains((prev) => applyStatus(prev, habitId, status, version));

    try {
      // Send the `version` (rung id) for EVERY status (not just completion) so
      // skip / missed / undo target THAT rung's row, not the whole habit. Omitting
      // it means the untiered ("whole habit") row, exactly as before.
      const body: {
        status: HabitStatus;
        date?: string;
        version?: number;
      } = isViewingToday ? { status } : { status, date: toYMD(viewedDate) };
      if (version != null) body.version = version;

      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${habitId}/log/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Omit date on today so the server stamps its own "today" (its call to
          // make, per the contract); send it only when logging another day.
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      // Un-completing a rung optimistically can't know which LOWER rungs were only
      // cascade-shown done (vs. completed in their own right), so reconcile an undo
      // from the server. Complete/skip/missed are exact optimistically — no reload.
      if (status === "PENDING" && version != null) triggerReload();
    } catch {
      setChains(snapshot);
    }
  }

  return { setHabitStatus };
}
