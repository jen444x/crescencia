import { useState, type Dispatch, type SetStateAction } from "react";
import { useToast } from "../../components/Toast";
import { forwardItemForPlan } from "./forward";
import { chainLabel } from "./chains";
import { formatTime, toYMD, isSameDay } from "./dates";
import type { Chain } from "./types";

// The two scope sentences the clarity gate appends after the one-line summary, so
// each edit kind reads honestly about what it touches (and leaves alone).
const PLACEMENT_DETAIL =
  "This changes where the habit sits — not when your chains run. Past days stay exactly as they were.";
const TIME_DETAIL =
  "This changes when this chain runs — not where any habit sits, and no other chain moves. Past days stay exactly as they were.";

// A pending clarity-gate edit: the one-line summary, the scope detail sentence,
// and the writer to run on confirm. null = nothing pending.
export type PendingForward = {
  summary: string;
  detail: string;
  run: () => void;
} | null;

// The clarity-gate / forward-write subsystem (Jennifer's #1 rule: nothing silently
// permanent). "Forward mode" (applyToFuture) turns a per-day edit into a recurring
// one — writing the routine from today forward instead of just today's layer — and
// every such edit first passes the confirm dialog (pendingForward). Bundles the
// placement funnel (persistForward/confirmForward) and the retime trio
// (postRetime/postRetimeForward/retimePlan), since retimePlan branches on the same
// gate. The page owns chains + reloadToken and injects them, matching the other
// plan hooks: chainsRef for the latest snapshot, setChains for optimistic
// edits/rollback, viewedDate for other-day payloads, triggerReload to re-pull
// /plan/, and isViewingToday for the "today-only" guard.
export function useForwardMode({
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
  const toast = useToast();

  const [applyToFuture, setApplyToFuture] = useState(false);
  // Forward mode only applies on today, defended at three layers: the toggle is
  // only rendered on today (so it can only turn ON there); navigating away drops
  // out of it (the DateNav handlers call leaveForwardMode, and the guard below
  // force-clears it whenever we're not on today); and every placement routing
  // guard re-checks `applyToFuture && isViewingToday` before taking the forward
  // path, so an edit can never anchor to the wrong day.
  const leaveForwardMode = () => setApplyToFuture(false);

  // Safety net: forward mode can never stay armed while its control is hidden. The
  // toggle only renders on today, so if the viewed day ever stops being today (any
  // path — DateNav, an external date change, a midnight rollover) force forward
  // mode off, so a stale "on" can't survive onto another day. Set-during-render
  // (React's "adjust state when a value changes" pattern) rather than an effect: no
  // extra commit+render pass, and it self-stops the moment applyToFuture is false.
  if (!isViewingToday && applyToFuture) setApplyToFuture(false);

  const [pendingForward, setPendingForward] = useState<PendingForward>(null);

  // Write a forward placement: the recurring routine gets ONE habit's move (fix
  // #3 — siblings keep their existing forward placement), from today forward, so
  // it repeats (today is mirrored even when frozen). On failure we roll the
  // optimistic state back. Placement only — never touches time/status.
  async function persistForward(
    optimisticPlans: Chain[],
    habitId: number,
    targetPlanId: number | null,
    snapshot: Chain[],
  ): Promise<boolean> {
    const item = forwardItemForPlan(optimisticPlans, habitId, targetPlanId);
    if (!item) {
      // The moved habit isn't where we expected in the optimistic state — bail
      // without writing anything rather than send a malformed payload.
      setChains(snapshot);
      return false;
    }
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/schedules/arrange-forward/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from_date: toYMD(new Date()), items: [item] }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      // The forward write re-projects today (and forward) — re-fetch so row_ids,
      // ordering, and the mirrored-into-today copy all reconcile.
      triggerReload();
      return true;
    } catch {
      setChains(snapshot);
      toast("Couldn't apply that change", { variant: "error" });
      return false;
    }
  }

  // Open the clarity gate for a forward placement: show a placement-only, one-line
  // summary ("... — every day from today") and run the writer only on confirm.
  // Cancel leaves everything untouched (nothing optimistic happened yet). This is
  // the single funnel every toggle-ON gesture passes through. `habitId` +
  // `targetPlanId` name the ONE habit being moved (fix #3): only its forward
  // generation is written; siblings are left alone.
  function confirmForward(
    summary: string,
    optimistic: () => Chain[],
    habitId: number,
    targetPlanId: number | null,
  ) {
    setPendingForward({
      summary,
      detail: PLACEMENT_DETAIL, // placement funnel: never mentions time
      run: () => {
        const snapshot = chainsRef.current;
        const next = optimistic();
        setChains(next);
        void persistForward(next, habitId, targetPlanId, snapshot);
      },
    });
  }

  // POST one chain's new absolute time (a per-day override, like the shift, no
  // cascade) and re-fetch the day — /plan/ returns the new effective times, already
  // re-sorted, so we don't hand-apply. Returns true on success; shared by a drag
  // and by its Undo.
  async function postRetime(chainId: number, time: string): Promise<boolean> {
    const today = isSameDay(viewedDate, new Date());
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/chains/retime/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          today
            ? { chain: chainId, time }
            : { chain: chainId, time, date: toYMD(viewedDate) },
        ),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Couldn't move that chain");
      }
      triggerReload(); // re-fetch the day's new times
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't move that chain", {
        variant: "error",
      });
      return false;
    }
  }

  // POST one chain's new absolute time PERMANENTLY from today forward (a dated
  // PlanTime row) and re-fetch — /plan/ returns the new effective times (today is
  // mirrored even when frozen), already re-sorted. The forward-time twin of
  // postRetime; writes ONLY this chain's time, never any placement.
  async function postRetimeForward(chainId: number, time: string) {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/chains/retime-forward/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // from_date defaults to today server-side; send it explicitly for clarity.
          body: JSON.stringify({
            chain: chainId,
            time,
            from_date: toYMD(new Date()),
          }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Couldn't move that chain");
      }
      triggerReload(); // re-fetch the day's new times
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't move that chain", {
        variant: "error",
      });
    }
  }

  // Drag handler: remember the block's time *before* the move, apply it, then offer
  // a one-tap Undo (the app's standard toast pattern, same as Skip day) that puts
  // it back. When there was no override, the previous effective time IS the
  // recurring time — so undoing all the way home clears the override.
  //
  // Forward mode (toggle on, on today): instead of a per-day override, route the
  // retime through the clarity gate and the recurring forward-writer so the new
  // time sticks every day from today. Time-only — never touches placement, and
  // (unlike shift) only THIS chain moves. No optimistic move until she confirms.
  async function retimePlan(chainId: number, time: string) {
    if (applyToFuture && isViewingToday) {
      const chainPlan = chainsRef.current.find((p) => p.id === chainId);
      const label =
        chainPlan?.name ||
        chainLabel(chainPlan?.habits ?? [], chainPlan?.time ?? null);
      setPendingForward({
        summary: `Move ${label} to ${formatTime(time)} — every day from today`,
        detail: TIME_DETAIL,
        run: () => void postRetimeForward(chainId, time),
      });
      return;
    }
    const previousTime =
      chainsRef.current.find((p) => p.id === chainId)?.time ?? null;
    const ok = await postRetime(chainId, time);
    if (!ok || previousTime == null) return;
    toast(`Moved to ${formatTime(time)}`, {
      action: {
        label: "Undo",
        onClick: () => postRetime(chainId, previousTime),
      },
    });
  }

  return {
    applyToFuture,
    setApplyToFuture,
    leaveForwardMode,
    pendingForward,
    setPendingForward,
    confirmForward,
    retimePlan,
  };
}
