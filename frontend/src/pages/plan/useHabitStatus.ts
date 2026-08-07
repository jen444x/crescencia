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

    // Time-based habits complete FROM their slot: if this habit has any rung
    // with a "by" time and it sits in a timed block, the block's time goes with
    // the log and the SERVER picks the version (hardest deadline the slot
    // meets; blown deadlines marked missed). Only complete/undo — skip and
    // missed are about the whole attempt, not a deadline.
    let slot: string | null = null;
    if (status === "COMPLETED" || status === "PENDING") {
      for (const chain of chainsRef.current) {
        const found = chain.habits.find((h) => h.id === habitId);
        if (found && chain.time && found.tiers?.some((t) => t.target_time)) {
          slot = chain.time.slice(0, 5); // "HH:MM:SS" -> "HH:MM"
          break;
        }
      }
    }

    try {
      // Send the `version` (rung id) for EVERY status (not just completion) so
      // skip / missed / undo target THAT rung's row, not the whole habit. Omitting
      // it means the untiered ("whole habit") row, exactly as before.
      const body: {
        status: HabitStatus;
        date?: string;
        version?: number;
        slot?: string;
      } = isViewingToday ? { status } : { status, date: toYMD(viewedDate) };
      if (slot != null) {
        body.slot = slot; // the slot picks the version — don't send one
      } else if (version != null) {
        body.version = version;
      }

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
      // from the server. A slot-completion also reconciles: the server decided
      // which rung got credit and which read missed, and only it knows.
      if (slot != null || (status === "PENDING" && version != null)) {
        triggerReload();
      }
    } catch {
      setChains(snapshot);
    }
  }

  return { setHabitStatus };
}
