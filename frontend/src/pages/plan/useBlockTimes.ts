import { useState, type Dispatch, type SetStateAction } from "react";
import { useToast } from "../../components/Toast";
import { toYMD, isSameDay, timeToMinutes } from "./dates";
import type { Chain } from "./types";

// Time-block (chain) operations that only touch `chains` + a re-fetch: add a new
// timed block, shift a block (running late), and rename a block. Retiming a block
// (retimePlan) stays in the page because it routes through the forward-mode
// clarity gate — page policy — so it isn't here.
//
// The page owns chains + reloadToken; the hook receives what it needs to mutate
// them: setChains/setNewPlanIds for optimistic edits, chainsRef for the latest
// snapshot (rename's rollback), viewedDate for other-day payloads, and
// triggerReload to re-pull /plan/ after a shift.
export function useBlockTimes({
  chainsRef,
  setChains,
  setNewPlanIds,
  viewedDate,
  triggerReload,
}: {
  chainsRef: { current: Chain[] };
  setChains: Dispatch<SetStateAction<Chain[]>>;
  setNewPlanIds: Dispatch<SetStateAction<Set<number>>>;
  viewedDate: Date;
  triggerReload: () => void;
}) {
  const toast = useToast();
  const [addingTime, setAddingTime] = useState(false);

  // Add a new timed block at `timeStr` (creates the chain, then inserts it in
  // time order). Optimistic: the empty block appears immediately so a habit can be
  // dropped into it; a reused existing block is a no-op.
  async function addTime(timeStr: string) {
    if (!timeStr) return;
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/chains/create/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: timeStr }),
      });
      if (!res.ok) throw new Error("Request failed");
      const data = await res.json(); // { id, time, created }
      setNewPlanIds((prev) => new Set(prev).add(data.id));
      setChains((prev) => {
        if (prev.some((p) => p.id === data.id)) return prev; // reused an existing block
        const block: Chain = {
          id: data.id,
          time: data.time,
          name: "",
          habits: [],
        };
        const timed = prev.filter((p) => p.id != null);
        const anytime = prev.filter((p) => p.id == null);
        const merged = [...timed, block].sort(
          (a, b) => timeToMinutes(a.time ?? "") - timeToMinutes(b.time ?? ""),
        );
        return [...merged, ...anytime];
      });
    } catch {
      toast("Couldn't add that time", { variant: "error" });
    }
  }

  // "Running late": push a chain (and everything after it that day) to a later
  // time — negative minutes pulls it earlier. The backend stores a per-day
  // override, never touching the recurring routine. We re-fetch afterward
  // because /plan/ returns the day's new effective times, already re-sorted.
  async function shiftFromPlan(chainId: number, minutes: number) {
    const today = isSameDay(viewedDate, new Date());
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/chains/shift/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          today
            ? { from_chain: chainId, minutes }
            : { from_chain: chainId, minutes, date: toYMD(viewedDate) },
        ),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Couldn't shift the day");
      }
      triggerReload(); // re-fetch the day's new times
    } catch (err) {
      // The shift didn't apply (nothing to roll back) — surface why, since this
      // used to fail silently.
      toast(err instanceof Error ? err.message : "Couldn't shift the day", {
        variant: "error",
      });
    }
  }

  // Name (or rename/clear) a timed chain. Optimistic: drop the trimmed name into
  // the block right away, then reconcile from the 200's saved name (the backend
  // trims/echoes it). On failure, restore the snapshot and toast. Only timed
  // blocks reach here — the "Anytime" group has no endpoint.
  async function renamePlan(chainId: number, name: string) {
    const trimmed = name.trim();
    const snapshot = chainsRef.current;
    setChains((prev) =>
      prev.map((p) => (p.id === chainId ? { ...p, name: trimmed } : p)),
    );
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/chains/${chainId}/name/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      const data = await res.json(); // { id, name }
      setChains((prev) =>
        prev.map((p) =>
          p.id === chainId ? { ...p, name: data.name ?? "" } : p,
        ),
      );
    } catch {
      setChains(snapshot);
      toast("Couldn't rename that chain", { variant: "error" });
    }
  }

  return {
    addingTime,
    setAddingTime,
    addTime,
    shiftFromPlan,
    renamePlan,
  };
}
